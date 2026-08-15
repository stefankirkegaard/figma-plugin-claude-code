/**
 * Message contracts shared by the plugin sandbox (`src/main`) and the plugin UI
 * (`src/ui`). Both bundles import this file, so a change here is a compile
 * error on whichever side has not been updated.
 */

export type Easing =
  | 'linear'
  | 'easeIn'
  | 'easeOut'
  | 'easeInOut'
  | 'easeOutBack'
  | 'easeOutBounce'

export interface NodeSummary {
  id: string
  name: string
  type: string
  width: number
  height: number
  visible: boolean
  hasExportSettings: boolean
  childCount: number
}

export interface SelectionState {
  pageName: string
  nodes: NodeSummary[]
}

/* ------------------------------------------------------------------ assets */

export type ExportFormat = 'PNG' | 'JPG' | 'SVG' | 'PDF'

export interface ExportRequest {
  nodeIds: string[]
  format: ExportFormat
  /** Raster scale factors. Ignored for SVG and PDF. */
  scales: number[]
  /** Append `@2x` style suffixes when more than one scale is requested. */
  suffixScales: boolean
}

export interface ExportedFile {
  name: string
  bytes: Uint8Array
  mime: string
}

/* ------------------------------------------------------------------ motion */

export type MotionMode = 'sequence' | 'timeline'

/** Properties a timeline track can drive. */
export type TrackProp = 'x' | 'y' | 'scale' | 'rotation' | 'opacity'

export interface Keyframe {
  /** Seconds from the start of the timeline. */
  t: number
  value: number
  /** Easing used to reach this keyframe from the previous one. */
  easing: Easing
}

export interface Track {
  nodeId: string
  nodeName: string
  prop: TrackProp
  keys: Keyframe[]
}

/** One hop of a smart-animate sequence: hold on a frame, then morph to the next. */
export interface SequenceStep {
  frameId: string
  frameName: string
  /** Seconds spent morphing into this frame from the previous one. */
  duration: number
  /** Seconds this frame is held before the next transition starts. */
  hold: number
  easing: Easing
}

export interface RenderRequest {
  mode: MotionMode
  fps: number
  /** Export scale factor applied to every rendered frame. */
  scale: number
  /** Ordered frames for `sequence` mode. The first step's `duration` is unused. */
  steps: SequenceStep[]
  /** Root frame for `timeline` mode. */
  stageFrameId: string
  /** Timeline length in seconds for `timeline` mode. */
  duration: number
  tracks: Track[]
  /**
   * Auto layout pins children to computed positions, which makes them
   * unanimatable. When true the render stage drops auto layout (children keep
   * their laid-out positions) so tracks can move them.
   */
  unlockAutoLayout: boolean
  /** Safety valve so a long duration at a high fps cannot lock up Figma. */
  maxFrames: number
}

export interface FrameInfo {
  id: string
  name: string
  width: number
  height: number
  /** Prototype destinations reachable from this frame, in reaction order. */
  reactions: {
    destinationId: string
    destinationName: string
    smartAnimate: boolean
    durationSec: number
    easing: Easing
  }[]
}

/* ---------------------------------------------------------------- messages */

export type UiToMain =
  | { type: 'ui:ready' }
  | { type: 'ui:resize'; width: number; height: number }
  | { type: 'ui:notify'; message: string; error?: boolean }
  | { type: 'design:rename'; pattern: string }
  | { type: 'design:fill'; hex: string; target: 'fill' | 'stroke' }
  | { type: 'design:opacity'; value: number }
  | { type: 'design:corner'; value: number }
  | { type: 'design:replaceText'; find: string; replace: string; matchCase: boolean }
  | { type: 'design:autoLayout'; direction: 'HORIZONTAL' | 'VERTICAL'; gap: number; padding: number }
  | { type: 'design:copyForClaude' }
  | { type: 'design:selectSimilar' }
  | { type: 'assets:scan' }
  | { type: 'assets:export'; request: ExportRequest }
  | { type: 'motion:listFrames' }
  | { type: 'motion:listLayers'; frameId: string }
  | { type: 'motion:sequenceFromPrototype'; frameId: string }
  | { type: 'motion:render'; request: RenderRequest }
  | { type: 'motion:cancel' }
  | { type: 'motion:zoomTo'; nodeId: string }

export type MainToUi =
  | { type: 'selection'; state: SelectionState }
  | { type: 'assets:list'; nodes: NodeSummary[] }
  | { type: 'assets:progress'; done: number; total: number }
  | { type: 'assets:done'; files: ExportedFile[] }
  | { type: 'motion:frames'; frames: FrameInfo[] }
  | { type: 'motion:layers'; layers: NodeSummary[] }
  | { type: 'motion:sequence'; steps: SequenceStep[] }
  | { type: 'motion:renderStart'; total: number; width: number; height: number }
  | { type: 'motion:frame'; index: number; total: number; bytes: Uint8Array }
  | { type: 'motion:renderDone'; cancelled: boolean }
  | { type: 'clipboard'; text: string; label: string }
  | { type: 'error'; message: string }
  | { type: 'busy'; busy: boolean; label?: string }
