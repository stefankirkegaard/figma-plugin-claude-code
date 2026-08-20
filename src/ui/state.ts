import type {
  BridgeState,
  ExportFormat,
  FrameInfo,
  MotionMode,
  NodeSummary,
  SelectionState,
  SequenceStep,
  Track,
  UiToMain,
} from '../shared/types'

export type Tab = 'claude' | 'design' | 'assets' | 'motion'
export type OutputFormat = 'GIF' | 'MP4' | 'PNG_SEQUENCE'

export interface RenderProgress {
  stage: 'rendering' | 'encoding'
  done: number
  total: number
}

export interface AppState {
  tab: Tab
  documentName: string
  selection: SelectionState
  /** Bridge to the MCP server, and the last few commands it ran. */
  bridgeState: BridgeState
  bridgePort: number
  bridgeError: string | null
  bridgeLog: string[]
  assets: NodeSummary[]
  assetSelection: Set<string>
  assetFormat: ExportFormat
  assetScales: Set<number>
  frames: FrameInfo[]
  layers: NodeSummary[]
  motionMode: MotionMode
  steps: SequenceStep[]
  stageFrameId: string
  duration: number
  tracks: Track[]
  outputFormat: OutputFormat
  fps: number
  renderScale: number
  maxWidth: number
  background: string
  transparent: boolean
  dither: boolean
  loop: boolean
  quality: number
  unlockAutoLayout: boolean
  progress: RenderProgress | null
  assetProgress: { done: number; total: number } | null
  busy: string | null
  message: { text: string; tone: 'info' | 'error' } | null
}

export const state: AppState = {
  tab: 'claude',
  documentName: '',
  selection: { pageName: '', nodes: [] },
  bridgeState: 'connecting',
  bridgePort: 3056,
  bridgeError: null,
  bridgeLog: [],
  assets: [],
  assetSelection: new Set(),
  assetFormat: 'PNG',
  assetScales: new Set([1, 2]),
  frames: [],
  layers: [],
  motionMode: 'sequence',
  steps: [],
  stageFrameId: '',
  duration: 2,
  tracks: [],
  outputFormat: 'GIF',
  fps: 24,
  renderScale: 1,
  maxWidth: 960,
  background: '#ffffff',
  transparent: false,
  dither: true,
  loop: true,
  quality: 0.8,
  unlockAutoLayout: true,
  progress: null,
  assetProgress: null,
  busy: null,
  message: null,
}

const listeners: (() => void)[] = []

export function subscribe(listener: () => void): void {
  listeners.push(listener)
}

/** Applies a patch and notifies every view. Views re-read `state` directly. */
export function update(patch: Partial<AppState> = {}): void {
  Object.assign(state, patch)
  for (const listener of listeners) listener()
}

export function send(message: UiToMain): void {
  parent.postMessage({ pluginMessage: message }, '*')
}

export function notify(text: string, tone: 'info' | 'error' = 'info'): void {
  update({ message: { text, tone } })
}

export function frameById(id: string): FrameInfo | undefined {
  return state.frames.find((frame) => frame.id === id)
}
