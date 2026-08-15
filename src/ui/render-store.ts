import type { FrameStore } from './encode/frames'

/**
 * The frames produced by the most recent render, shared between the message
 * router (which fills it) and the motion view (which previews and encodes it).
 */
export const renderStore: { store: FrameStore | null } = { store: null }
