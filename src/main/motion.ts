import type { FrameInfo, RenderRequest, SequenceStep, Track, TrackProp } from '../shared/types'
import { ease, easingFromFigma, lerp, lerpColor, setPose, setScale, transformToPose, type Pose } from './pose'
import { isExportable, post, tick } from './util'

/** Frames wider than this (after scaling) are refused by Figma's exporter. */
const MAX_EXPORT_EDGE = 4096

let cancelRequested = false

export function cancelRender(): void {
  cancelRequested = true
}

/* -------------------------------------------------------------- inventory */

/** Top-level renderable containers on the current page, with their prototype links. */
export function listFrames(): FrameInfo[] {
  const candidates = figma.currentPage.children.filter(
    (node) => node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE',
  )
  // Prototype destinations are resolved against this page rather than through
  // `getNodeById`, which is unavailable under dynamic-page document access.
  const names = new Map(candidates.map((node) => [node.id, node.name]))
  return candidates.map((node) => ({
    id: node.id,
    name: node.name,
    width: Math.round(node.width),
    height: Math.round(node.height),
    reactions: readReactions(node, names),
  }))
}

function readReactions(node: SceneNode, names: Map<string, string>): FrameInfo['reactions'] {
  if (!('reactions' in node)) return []
  const out: FrameInfo['reactions'] = []
  for (const reaction of node.reactions) {
    const actions = reaction.actions ?? (reaction.action ? [reaction.action] : [])
    for (const action of actions) {
      if (action.type !== 'NODE' || !action.destinationId) continue
      // A destination on another page cannot take part in a render on this one.
      const destinationName = names.get(action.destinationId)
      if (destinationName === undefined) continue
      const transition = action.transition as
        | { type?: string; duration?: number; easing?: { type: string } }
        | null
        | undefined
      out.push({
        destinationId: action.destinationId,
        destinationName,
        smartAnimate: transition?.type === 'SMART_ANIMATE',
        // Figma reports transition durations in seconds.
        durationSec: clamp(transition?.duration ?? 0.3, 0.05, 10),
        easing: easingFromFigma(transition?.easing),
      })
    }
  }
  return out
}

/**
 * Walks prototype links from `startId` to build an ordered sequence, stopping at
 * the first repeated frame so a loop back to the start terminates.
 */
export function sequenceFromPrototype(startId: string): SequenceStep[] {
  const frames = new Map(listFrames().map((frame) => [frame.id, frame]))
  const steps: SequenceStep[] = []
  const seen = new Set<string>()
  let currentId: string | undefined = startId

  while (currentId !== undefined && frames.has(currentId) && !seen.has(currentId)) {
    seen.add(currentId)
    const frame: FrameInfo = frames.get(currentId)!
    const previous = steps.length === 0 ? undefined : frames.get(steps[steps.length - 1].frameId)
    const link = previous?.reactions.find((reaction) => reaction.destinationId === currentId)
    steps.push({
      frameId: frame.id,
      frameName: frame.name,
      duration: link?.durationSec ?? 0.4,
      hold: 0.4,
      easing: link?.easing ?? 'easeInOut',
    })
    currentId = frame.reactions[0]?.destinationId
  }
  return steps
}

export async function listLayers(frameId: string) {
  const frame = await figma.getNodeByIdAsync(frameId)
  if (!frame || !('children' in frame)) return []
  const layers: SceneNode[] = []
  const visit = (nodes: readonly SceneNode[], depth: number) => {
    for (const node of nodes) {
      layers.push(node)
      // Two levels is enough to pick animation targets without flooding the list.
      if (depth < 1 && 'children' in node) visit(node.children, depth + 1)
    }
  }
  visit(frame.children as readonly SceneNode[], 0)
  return layers
}

/* ------------------------------------------------------------ node states */

interface NodeState {
  /** Top-left of the unrotated box, in parent coordinates. */
  x: number
  y: number
  rotation: number
  width: number
  height: number
  opacity: number
  fill: RGB | null
  fillOpacity: number
  cornerRadius: number | null
  fontSize: number | null
}

/**
 * Inverts {@link setPose}: `node.x`/`node.y` report the translation component of
 * the transform, which for a rotated node is not the top-left of its box.
 */
function readPose(node: SceneNode): Pose {
  // Every node that can be posed has a transform; the rest sit at the origin.
  if (!('relativeTransform' in node)) return { x: 0, y: 0, rotation: 0 }
  return transformToPose(node.width, node.height, node.relativeTransform)
}

function readState(node: SceneNode): NodeState {
  const pose = readPose(node)
  const paint = firstSolidPaint(node)
  const corner = 'cornerRadius' in node && typeof node.cornerRadius === 'number' ? node.cornerRadius : null
  const fontSize = node.type === 'TEXT' && typeof node.fontSize === 'number' ? node.fontSize : null
  return {
    ...pose,
    width: 'width' in node ? node.width : 0,
    height: 'height' in node ? node.height : 0,
    opacity: 'opacity' in node ? node.opacity : 1,
    fill: paint ? paint.color : null,
    fillOpacity: paint?.opacity ?? 1,
    cornerRadius: corner,
    fontSize,
  }
}

function firstSolidPaint(node: SceneNode): SolidPaint | null {
  if (!('fills' in node)) return null
  const fills = node.fills
  if (fills === figma.mixed || !Array.isArray(fills)) return null
  const solid = fills.find((paint) => paint.type === 'SOLID' && paint.visible !== false)
  return (solid as SolidPaint | undefined) ?? null
}

function setSolidFill(node: SceneNode, color: RGB, opacity: number): void {
  if (!('fills' in node)) return
  const fills = node.fills
  if (fills === figma.mixed || !Array.isArray(fills)) return
  const next = fills.map((paint) =>
    paint.type === 'SOLID' && paint.visible !== false ? { ...paint, color, opacity } : paint,
  )
  try {
    node.fills = next as Paint[]
  } catch {
    // Locked or read-only fills (e.g. some instance sub-layers).
  }
}

function resizeSafe(node: SceneNode, width: number, height: number): void {
  if (!('resize' in node)) return
  try {
    node.resize(Math.max(0.01, width), Math.max(0.01, height))
  } catch {
    // Text with auto-resize, and a few other node types, refuse explicit resizing.
  }
}

/* --------------------------------------------------- smart-animate matching */

type Animator = (t: number) => void

/**
 * Pairs the layers of two frames the way Smart Animate does: by name, within the
 * same parent, falling back to document order when names repeat. Layers only in
 * the source fade out, layers only in the destination are copied in and fade up.
 */
function buildSegment(stage: SceneNode, target: SceneNode, isRoot: boolean, out: Animator[], fonts: FontName[]): void {
  out.push(pairAnimator(stage, target, isRoot))

  if (!('children' in stage) || !('children' in target)) return
  const stageChildren = [...stage.children]
  const targetChildren = [...target.children]

  const buckets = new Map<string, SceneNode[]>()
  for (const child of targetChildren) {
    const bucket = buckets.get(child.name)
    if (bucket) bucket.push(child)
    else buckets.set(child.name, [child])
  }

  const matched = new Set<string>()
  for (const child of stageChildren) {
    const bucket = buckets.get(child.name)
    const partner = bucket && bucket.length > 0 ? bucket.shift() : undefined
    if (partner) {
      matched.add(partner.id)
      collectFonts(partner, fonts)
      buildSegment(child, partner, false, out, fonts)
    } else {
      out.push(exitAnimator(child))
    }
  }

  for (let index = 0; index < targetChildren.length; index++) {
    const child = targetChildren[index]
    if (matched.has(child.id)) continue
    const entering = adoptInto(stage, child, index)
    if (entering) out.push(enterAnimator(entering, readState(child)))
  }
}

function collectFonts(node: SceneNode, fonts: FontName[]): void {
  if (node.type !== 'TEXT') return
  const name = node.fontName
  if (name !== figma.mixed) fonts.push(name)
}

/** Copies a destination-only layer into the stage so it can fade in. */
function adoptInto(stageParent: SceneNode, source: SceneNode, index: number): SceneNode | null {
  if (!('insertChild' in stageParent)) return null
  let copy: SceneNode
  try {
    copy = source.clone()
  } catch {
    return null
  }
  try {
    const container = stageParent as ChildrenMixin & SceneNode
    container.insertChild(Math.min(index, container.children.length), copy)
    return copy
  } catch {
    copy.remove()
    return null
  }
}

function pairAnimator(node: SceneNode, target: SceneNode, isRoot: boolean): Animator {
  const from = readState(node)
  const to = readState(target)
  const sizeChanged = Math.abs(from.width - to.width) > 0.01 || Math.abs(from.height - to.height) > 0.01
  const poseChanged =
    Math.abs(from.x - to.x) > 0.01 || Math.abs(from.y - to.y) > 0.01 || Math.abs(from.rotation - to.rotation) > 0.01
  const fillChanged =
    from.fill !== null &&
    to.fill !== null &&
    (from.fill.r !== to.fill.r ||
      from.fill.g !== to.fill.g ||
      from.fill.b !== to.fill.b ||
      from.fillOpacity !== to.fillOpacity)
  const cornerChanged = from.cornerRadius !== null && to.cornerRadius !== null && from.cornerRadius !== to.cornerRadius
  const fontChanged = from.fontSize !== null && to.fontSize !== null && from.fontSize !== to.fontSize

  return (t) => {
    if (sizeChanged) resizeSafe(node, lerp(from.width, to.width, t), lerp(from.height, to.height, t))
    // The stage frame stays where it was parked; only its contents animate.
    if (poseChanged && !isRoot) {
      setPose(node, lerp(from.x, to.x, t), lerp(from.y, to.y, t), lerp(from.rotation, to.rotation, t))
    }
    if (from.opacity !== to.opacity && 'opacity' in node) node.opacity = lerp(from.opacity, to.opacity, t)
    if (fillChanged) setSolidFill(node, lerpColor(from.fill!, to.fill!, t), lerp(from.fillOpacity, to.fillOpacity, t))
    if (cornerChanged && 'cornerRadius' in node) {
      try {
        ;(node as { cornerRadius: number }).cornerRadius = lerp(from.cornerRadius!, to.cornerRadius!, t)
      } catch {
        /* mixed corner radii */
      }
    }
    if (fontChanged && node.type === 'TEXT') {
      try {
        node.fontSize = lerp(from.fontSize!, to.fontSize!, t)
      } catch {
        /* font not loaded */
      }
    }
  }
}

function exitAnimator(node: SceneNode): Animator {
  const from = 'opacity' in node ? node.opacity : 1
  return (t) => {
    if ('opacity' in node) node.opacity = from * (1 - t)
  }
}

function enterAnimator(node: SceneNode, to: NodeState): Animator {
  return (t) => {
    if ('opacity' in node) node.opacity = to.opacity * t
  }
}

/* ------------------------------------------------------------ stage set-up */

/**
 * Auto layout recomputes child positions on every change, which silently undoes
 * anything an animation writes. Converting the stage's auto-layout frames to
 * free positioning keeps the laid-out result while making layers movable.
 */
function unlockAutoLayout(root: SceneNode): SceneNode {
  const skip = new Set<string>()
  let current = root

  for (let pass = 0; pass < 1000; pass++) {
    const target = findNode(
      current,
      (node) => 'layoutMode' in node && node.layoutMode !== 'NONE' && !skip.has(node.id),
    )
    if (!target) break

    if (target.type === 'INSTANCE') {
      const wasRoot = target === current
      try {
        const detached = target.detachInstance()
        if (wasRoot) current = detached
        continue
      } catch {
        // Instances nested inside other instances cannot be detached.
        skip.add(target.id)
        continue
      }
    }

    skip.add(target.id)
    try {
      ;(target as FrameNode).layoutMode = 'NONE'
    } catch {
      /* leave this container laid out */
    }
  }
  return current
}

function findNode(root: SceneNode, predicate: (node: SceneNode) => boolean): SceneNode | null {
  if (predicate(root)) return root
  if ('children' in root) {
    for (const child of root.children) {
      const found = findNode(child, predicate)
      if (found) return found
    }
  }
  return null
}

/**
 * Creates a throwaway copy of `frame` parked far off to the side so the render
 * never disturbs the user's artwork. The copy is always removed by `dispose`.
 */
function createStage(frame: SceneNode, unlock: boolean): { stage: SceneNode; dispose: () => void } {
  let stage: SceneNode = frame.clone()
  stage.name = '⧉ render stage'
  if ('x' in stage && 'x' in frame) {
    stage.x = frame.x + 200000
    stage.y = frame.y
  }
  if (unlock) stage = unlockAutoLayout(stage)
  const handle = stage
  return {
    stage,
    dispose: () => {
      try {
        if (!handle.removed) handle.remove()
      } catch {
        /* already gone */
      }
    },
  }
}

/** Maps original node ids onto their counterparts in a structural clone. */
function mapClone(original: SceneNode, clone: SceneNode, map: Map<string, SceneNode>): void {
  map.set(original.id, clone)
  if ('children' in original && 'children' in clone) {
    const count = Math.min(original.children.length, clone.children.length)
    for (let i = 0; i < count; i++) mapClone(original.children[i], clone.children[i], map)
  }
}

/* ------------------------------------------------------- timeline sampling */

function evaluateTrack(track: Track, time: number): number {
  const keys = [...track.keys].sort((a, b) => a.t - b.t)
  if (keys.length === 0) return defaultValue(track.prop)
  if (time <= keys[0].t) return keys[0].value
  const last = keys[keys.length - 1]
  if (time >= last.t) return last.value

  for (let i = 1; i < keys.length; i++) {
    const previous = keys[i - 1]
    const next = keys[i]
    if (time > next.t) continue
    const span = next.t - previous.t
    const progress = span <= 0 ? 1 : (time - previous.t) / span
    return lerp(previous.value, next.value, ease(next.easing, progress))
  }
  return last.value
}

function defaultValue(prop: TrackProp): number {
  return prop === 'scale' ? 1 : prop === 'opacity' ? 1 : 0
}

interface TimelineTarget {
  node: SceneNode
  base: NodeState
  tracks: Partial<Record<TrackProp, Track>>
}

/**
 * Track values are relative to the layer's resting state: `x`/`y` are pixel
 * offsets, `rotation` is a degree offset, `scale` is a multiplier around the
 * layer's centre and `opacity` is absolute.
 */
function applyTimeline(target: TimelineTarget, time: number): void {
  const { node, base, tracks } = target

  if (tracks.scale) setScale(node, base.width, evaluateTrack(tracks.scale, time))

  const centerX = base.x + base.width / 2 + (tracks.x ? evaluateTrack(tracks.x, time) : 0)
  const centerY = base.y + base.height / 2 + (tracks.y ? evaluateTrack(tracks.y, time) : 0)
  const rotation = base.rotation + (tracks.rotation ? evaluateTrack(tracks.rotation, time) : 0)
  setPose(node, centerX - node.width / 2, centerY - node.height / 2, rotation)

  if (tracks.opacity && 'opacity' in node) {
    node.opacity = clamp(evaluateTrack(tracks.opacity, time), 0, 1)
  }
}

/* ------------------------------------------------------------- the render */

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

async function exportFrame(node: SceneNode, scale: number): Promise<Uint8Array> {
  return node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } })
}

async function resolveFrame(id: string): Promise<SceneNode> {
  const node = await figma.getNodeByIdAsync(id)
  if (!node || !isExportable(node)) throw new Error('That frame is no longer on the page — refresh the frame list.')
  return node
}

/** Fits the requested scale inside Figma's export limits. */
function safeScale(requested: number, width: number, height: number): number {
  const longest = Math.max(width, height)
  if (longest <= 0) return requested
  return Math.min(requested, MAX_EXPORT_EDGE / longest)
}

export async function render(request: RenderRequest): Promise<void> {
  cancelRequested = false
  const fps = clamp(Math.round(request.fps), 1, 60)

  if (request.mode === 'sequence') await renderSequence(request, fps)
  else await renderTimeline(request, fps)
}

async function renderSequence(request: RenderRequest, fps: number): Promise<void> {
  const steps = request.steps
  if (steps.length === 0) throw new Error('Add at least one frame to the sequence.')

  const frames = await Promise.all(steps.map((step) => resolveFrame(step.frameId)))
  const width = Math.max(...frames.map((frame) => frame.width))
  const height = Math.max(...frames.map((frame) => frame.height))
  const scale = safeScale(request.scale, width, height)

  const counts = steps.map((step, index) => ({
    transition: index === 0 ? 0 : Math.max(1, Math.round(step.duration * fps)),
    hold: Math.max(index === 0 ? 1 : 0, Math.round(step.hold * fps)),
  }))
  const total = counts.reduce((sum, count) => sum + count.transition + count.hold, 0)
  if (total > request.maxFrames) {
    throw new Error(
      `That is ${total} frames, over the ${request.maxFrames} frame limit. Lower the frame rate or shorten the timings.`,
    )
  }

  post({
    type: 'motion:renderStart',
    total,
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  })

  let emitted = 0
  const emit = (bytes: Uint8Array) => {
    post({ type: 'motion:frame', index: emitted, total, bytes })
    emitted++
  }

  for (let index = 0; index < steps.length && !cancelRequested; index++) {
    const step = steps[index]
    const frame = frames[index]

    if (index > 0) {
      const { stage, dispose } = createStage(frames[index - 1], request.unlockAutoLayout)
      try {
        const animators: Animator[] = []
        const fonts: FontName[] = []
        buildSegment(stage, frame, true, animators, fonts)
        await loadFonts(fonts)

        const frameCount = counts[index].transition
        for (let i = 1; i <= frameCount && !cancelRequested; i++) {
          const progress = ease(step.easing, i / frameCount)
          for (const animate of animators) animate(progress)
          emit(await exportFrame(stage, scale))
          if (i % 4 === 0) await tick()
        }
      } finally {
        dispose()
      }
    }

    if (cancelRequested) break

    const holdCount = counts[index].hold
    if (holdCount > 0) {
      // A held frame is identical every time, so it is exported once and repeated.
      const bytes = await exportFrame(frame, scale)
      for (let i = 0; i < holdCount && !cancelRequested; i++) emit(bytes)
      await tick()
    }
  }

  post({ type: 'motion:renderDone', cancelled: cancelRequested })
}

async function renderTimeline(request: RenderRequest, fps: number): Promise<void> {
  const source = await resolveFrame(request.stageFrameId)
  if (request.tracks.length === 0) throw new Error('Add at least one animation track.')

  const duration = clamp(request.duration, 0.1, 120)
  const total = Math.max(1, Math.round(duration * fps))
  if (total > request.maxFrames) {
    throw new Error(
      `That is ${total} frames, over the ${request.maxFrames} frame limit. Lower the frame rate or shorten the duration.`,
    )
  }

  const scale = safeScale(request.scale, source.width, source.height)
  const { stage, dispose } = createStage(source, request.unlockAutoLayout)

  try {
    const lookup = new Map<string, SceneNode>()
    mapClone(source, stage, lookup)

    const targets = new Map<string, TimelineTarget>()
    const missing: string[] = []
    for (const track of request.tracks) {
      const node = lookup.get(track.nodeId)
      if (!node) {
        missing.push(track.nodeName)
        continue
      }
      let target = targets.get(track.nodeId)
      if (!target) {
        target = { node, base: readState(node), tracks: {} }
        targets.set(track.nodeId, target)
      }
      target.tracks[track.prop] = track
    }
    if (targets.size === 0) {
      throw new Error(`None of the animated layers are inside "${source.name}".`)
    }
    if (missing.length > 0) {
      figma.notify(`Skipped ${missing.length} layer(s) not found in the frame: ${missing.join(', ')}`)
    }

    post({
      type: 'motion:renderStart',
      total,
      width: Math.round(source.width * scale),
      height: Math.round(source.height * scale),
    })

    for (let i = 0; i < total && !cancelRequested; i++) {
      const time = (i / Math.max(1, total - 1)) * duration
      for (const target of targets.values()) applyTimeline(target, time)
      post({ type: 'motion:frame', index: i, total, bytes: await exportFrame(stage, scale) })
      if (i % 4 === 0) await tick()
    }
  } finally {
    dispose()
  }

  post({ type: 'motion:renderDone', cancelled: cancelRequested })
}

async function loadFonts(fonts: FontName[]): Promise<void> {
  const seen = new Set<string>()
  const jobs: Promise<void>[] = []
  for (const font of fonts) {
    const key = `${font.family}__${font.style}`
    if (seen.has(key)) continue
    seen.add(key)
    jobs.push(figma.loadFontAsync(font).catch(() => undefined))
  }
  await Promise.all(jobs)
}
