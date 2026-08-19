import type {
  Easing,
  MotionMode,
  NodeSummary,
  RenderRequest,
  RpcRequest,
  RpcResult,
  SequenceStep,
  Track,
} from '../shared/types'
import { waitFor } from './bus'
import { offerDownload } from './download'
import { renderStore } from './render-store'
import { notify, send, state, subscribe, update, type OutputFormat } from './state'
import { exportRenderedFrames } from './views/motion'

/** Envelope version, matched against `bridge/channel.mjs`. */
const PROTOCOL = 1

const RENDER_TIMEOUT_MS = 15 * 60_000
const RPC_TIMEOUT_MS = 60_000
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 10_000
const LOG_LINES = 8

let socket: WebSocket | null = null
let reconnectTimer = 0
let reconnectDelay = RECONNECT_MIN_MS
/** Set while the user has switched the bridge off, so retries stop. */
let wanted = true

/** Commands sent on to the sandbox, awaiting an `rpc:result`. */
const pendingToMain = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: number }>()
let nextMainId = 1

/** The bridge request currently being served, so progress can be attributed. */
let activeRequestId: string | null = null

/* --------------------------------------------------------------- lifecycle */

export function connectBridge(): void {
  wanted = true
  clearTimeout(reconnectTimer)
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return

  update({ bridgeState: 'connecting', bridgeError: null })

  let next: WebSocket
  try {
    next = new WebSocket(`ws://127.0.0.1:${state.bridgePort}`)
  } catch (error) {
    // A blocked or malformed URL never reaches `onerror`.
    update({ bridgeState: 'off', bridgeError: message(error) })
    return
  }
  socket = next

  next.onopen = () => {
    reconnectDelay = RECONNECT_MIN_MS
    update({ bridgeState: 'connected', bridgeError: null })
    sendHello()
    log('connected to the bridge')
  }

  next.onmessage = (event) => {
    let request: RpcRequest
    try {
      request = JSON.parse(String(event.data))
    } catch {
      return
    }
    void serve(request)
  }

  next.onclose = () => {
    if (socket === next) socket = null
    update({ bridgeState: wanted ? 'connecting' : 'off' })
    if (wanted) retry()
  }

  // `onerror` carries no detail from a sandboxed iframe; `onclose` follows it.
  next.onerror = () => {
    if (state.bridgeState === 'connecting' && !state.bridgeError) {
      update({ bridgeError: `Nothing is listening on port ${state.bridgePort}. Start the bridge, or let Claude Code start it.` })
    }
  }
}

export function disconnectBridge(): void {
  wanted = false
  clearTimeout(reconnectTimer)
  socket?.close()
  socket = null
  update({ bridgeState: 'off', bridgeError: null })
}

function retry(): void {
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    if (wanted) connectBridge()
  }, reconnectDelay) as unknown as number
  reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 2)
}

function sendHello(): void {
  emit({ v: PROTOCOL, type: 'hello', document: state.documentName, page: state.selection.pageName })
}

/** Keeps the bridge's idea of the open document current. */
export function pushBridgeContext(): void {
  if (state.bridgeState !== 'connected') return
  emit({ v: PROTOCOL, type: 'context', document: state.documentName, page: state.selection.pageName })
}

function emit(payload: unknown): void {
  if (socket?.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify(payload))
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function log(line: string): void {
  update({ bridgeLog: [line, ...state.bridgeLog].slice(0, LOG_LINES) })
}

/* --------------------------------------------------------------- serving */

async function serve(request: RpcRequest): Promise<void> {
  const previous = activeRequestId
  activeRequestId = request.id
  log(request.command)
  try {
    const result = uiCommands[request.command]
      ? await uiCommands[request.command](request.params ?? {})
      : await callMain(request.command, request.params ?? {})
    emit({ v: PROTOCOL, id: request.id, ok: true, result })
  } catch (error) {
    const text = message(error)
    log(`${request.command} failed — ${text}`)
    emit({ v: PROTOCOL, id: request.id, ok: false, error: text })
  } finally {
    activeRequestId = previous
  }
}

/** Forwards a command to the sandbox and waits for its single answer. */
function callMain(command: string, params: Record<string, unknown>, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
  const id = `m${nextMainId++}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingToMain.delete(id)
      reject(new Error(`Figma did not answer "${command}" within ${Math.round(timeoutMs / 1000)}s.`))
    }, timeoutMs) as unknown as number
    pendingToMain.set(id, { resolve, reject, timer })
    send({ type: 'rpc:call', request: { id, command, params } })
  })
}

/** Called by the message router for every `rpc:result` the sandbox posts. */
export function handleRpcResult(response: RpcResult): void {
  const entry = pendingToMain.get(response.id)
  if (!entry) return
  pendingToMain.delete(response.id)
  clearTimeout(entry.timer)
  if (response.ok) entry.resolve(response.result)
  else entry.reject(new Error(response.error ?? 'The Figma sandbox reported an unknown failure.'))
}

/* ------------------------------------------------------- UI-side commands */

type UiCommand = (params: Record<string, unknown>) => Promise<unknown>

const uiCommands: Record<string, UiCommand> = {
  render_motion: (params) => renderMotion(params),
}

function pick<T>(params: Record<string, unknown>, key: string, fallback: T): T {
  const value = params[key]
  return value === undefined || value === null ? fallback : (value as T)
}

async function renderMotion(params: Record<string, unknown>): Promise<unknown> {
  const mode: MotionMode = pick<string>(params, 'mode', 'sequence') === 'timeline' ? 'timeline' : 'sequence'
  const format = pick<OutputFormat>(params, 'format', 'GIF')
  const fps = pick(params, 'fps', 24)

  const steps = mode === 'sequence' ? await buildSteps(params) : []
  const tracks = mode === 'timeline' ? await buildTracks(params) : []
  const stageFrameId = pick(params, 'stageFrameId', steps[0]?.frameId ?? state.stageFrameId)

  if (mode === 'sequence' && steps.length < 2) {
    throw new Error('Sequence mode needs at least two frames — pass frameIds, steps, or fromPrototypeFrameId.')
  }
  if (mode === 'timeline') {
    if (!stageFrameId) throw new Error('Timeline mode needs stageFrameId.')
    if (tracks.length === 0) throw new Error('Timeline mode needs at least one track.')
  }

  // Mirroring the request into the panel means the user watches Claude work.
  update({
    tab: 'motion',
    motionMode: mode,
    outputFormat: format,
    fps,
    renderScale: pick(params, 'scale', 1),
    maxWidth: pick(params, 'maxWidth', 960),
    background: pick(params, 'background', '#ffffff'),
    transparent: pick(params, 'transparent', false),
    dither: pick(params, 'dither', true),
    loop: pick(params, 'loop', true),
    quality: pick(params, 'quality', 0.8),
    unlockAutoLayout: pick(params, 'unlockAutoLayout', true),
    steps,
    tracks,
    stageFrameId,
    duration: pick(params, 'duration', 2),
  })

  const request: RenderRequest = {
    mode,
    fps,
    scale: state.renderScale,
    steps,
    stageFrameId,
    duration: state.duration,
    tracks,
    unlockAutoLayout: state.unlockAutoLayout,
    maxFrames: pick(params, 'maxFrames', 900),
  }

  renderStore.owner = 'bridge'
  try {
    const done = waitFor('motion:renderDone', RENDER_TIMEOUT_MS)
    send({ type: 'motion:render', request })
    const result = await done
    if (result.cancelled) throw new Error('The render was cancelled in Figma.')

    const file = await exportRenderedFrames()
    if (!file) throw new Error('The render produced no frames.')

    // The user gets the file too — a bridge render is still a real export.
    offerDownload(file.bytes, file.name, file.mime)
    notify(`Sent ${file.name} to Claude.`)

    return {
      file: { name: file.name, mime: file.mime, base64: encodeBase64(file.bytes) },
      frames: renderStore.store?.count ?? 0,
      note: format === 'MP4' && state.transparent ? 'MP4 cannot carry alpha, so the matte colour was composited in.' : undefined,
    }
  } finally {
    renderStore.owner = 'panel'
  }
}

async function buildSteps(params: Record<string, unknown>): Promise<SequenceStep[]> {
  const prototypeFrame = pick(params, 'fromPrototypeFrameId', '')
  if (prototypeFrame) {
    return (await callMain('prototype_steps', { frameId: prototypeFrame })) as SequenceStep[]
  }

  const explicit = params.steps as { frameId: string; duration?: number; hold?: number; easing?: Easing }[] | undefined
  const frameIds = params.frameIds as string[] | undefined
  const easing = pick<Easing>(params, 'easing', 'easeInOut')

  const source = explicit?.length
    ? explicit
    : (frameIds ?? []).map((frameId) => ({
        frameId,
        duration: pick(params, 'stepDuration', 0.6),
        hold: pick(params, 'stepHold', 0.4),
        easing,
      }))

  const names = await frameNames(source.map((step) => step.frameId))
  return source.map((step) => ({
    frameId: step.frameId,
    frameName: names.get(step.frameId) ?? 'Frame',
    duration: step.duration ?? pick(params, 'stepDuration', 0.6),
    hold: step.hold ?? pick(params, 'stepHold', 0.4),
    easing: step.easing ?? easing,
  }))
}

async function buildTracks(params: Record<string, unknown>): Promise<Track[]> {
  const tracks = (params.tracks ?? []) as Omit<Track, 'nodeName'>[]
  if (tracks.length === 0) return []
  const names = await frameNames(tracks.map((track) => track.nodeId))
  return tracks.map((track) => ({
    ...track,
    nodeName: names.get(track.nodeId) ?? 'Layer',
    keys: [...track.keys].sort((a, b) => a.t - b.t),
  }))
}

/** Layer names for ids, so the panel labels a Claude-driven render properly. */
async function frameNames(list: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(list.filter(Boolean))]
  const names = new Map<string, string>()
  for (const frame of state.frames) names.set(frame.id, frame.name)
  const unknown = unique.filter((id) => !names.has(id))
  if (unknown.length === 0) return names

  const resolved = (await callMain('resolve_frames', { frameIds: unknown })) as NodeSummary[]
  for (const node of resolved) names.set(node.id, node.name)
  return names
}

function encodeBase64(bytes: Uint8Array): string {
  // `String.fromCharCode(...bytes)` blows the argument limit on real exports.
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

/* -------------------------------------------------------------- progress */

let lastProgress = ''

subscribe(() => {
  if (!activeRequestId) return
  const progress = state.progress ?? (state.assetProgress ? { stage: 'exporting' as const, ...state.assetProgress } : null)
  if (!progress) return

  const line = `${progress.stage}:${progress.done}/${progress.total}`
  if (line === lastProgress) return
  lastProgress = line
  emit({
    v: PROTOCOL,
    type: 'progress',
    id: activeRequestId,
    label: progress.stage,
    done: progress.done,
    total: progress.total,
  })
})
