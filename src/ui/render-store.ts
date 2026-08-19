import type { FrameStore } from './encode/frames'

/**
 * The frames produced by the most recent render, shared between the message
 * router (which fills it) and the motion view (which previews and encodes it).
 *
 * `owner` says who asked for the render: a panel render encodes and downloads
 * itself as soon as it finishes, while a bridge render is awaited by the
 * bridge, which encodes it once and ships the bytes to Claude.
 */
export const renderStore: { store: FrameStore | null; owner: 'panel' | 'bridge' } = {
  store: null,
  owner: 'panel',
}
