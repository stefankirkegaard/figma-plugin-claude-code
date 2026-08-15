import { ArrayBufferTarget, Muxer } from 'mp4-muxer'
import type { FrameRenderer } from './frames'

export interface VideoOptions {
  fps: number
  /** 0-1; scales the target bitrate. */
  quality: number
  onProgress?: (done: number, total: number) => void
}

export interface VideoResult {
  bytes: Uint8Array
  codecLabel: string
}

/** Ordered by preference: H.264 plays everywhere, VP9-in-MP4 is the fallback. */
const CANDIDATES: { codec: string; muxer: 'avc' | 'vp9'; label: string }[] = [
  { codec: 'avc1.640028', muxer: 'avc', label: 'H.264 High' },
  { codec: 'avc1.4d0028', muxer: 'avc', label: 'H.264 Main' },
  { codec: 'avc1.42001f', muxer: 'avc', label: 'H.264 Baseline' },
  { codec: 'vp09.00.10.08', muxer: 'vp9', label: 'VP9' },
]

export function videoEncodingSupported(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined'
}

async function pickCodec(width: number, height: number, framerate: number, bitrate: number) {
  for (const candidate of CANDIDATES) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec: candidate.codec,
        width,
        height,
        framerate,
        bitrate,
      })
      if (support.supported) return candidate
    } catch {
      // An unparseable codec string throws rather than returning unsupported.
    }
  }
  return null
}

export async function encodeVideo(
  count: number,
  renderer: FrameRenderer,
  options: VideoOptions,
): Promise<VideoResult> {
  if (count === 0) throw new Error('There are no frames to encode.')
  if (!videoEncodingSupported()) {
    throw new Error(
      'This build of Figma has no WebCodecs video encoder. Export a GIF or a PNG sequence instead, or try the Figma desktop app.',
    )
  }

  const { width, height } = renderer
  const fps = Math.max(1, Math.round(options.fps))
  const quality = Math.max(0.1, Math.min(1, options.quality))
  const bitrate = Math.round(Math.min(24e6, Math.max(800e3, width * height * fps * 0.14 * quality)))

  const candidate = await pickCodec(width, height, fps, bitrate)
  if (!candidate) throw new Error('No supported video codec was found. Export a GIF or a PNG sequence instead.')

  const target = new ArrayBufferTarget()
  const muxer = new Muxer({
    target,
    video: { codec: candidate.muxer, width, height, frameRate: fps },
    // Puts the index at the front so the file can be scrubbed without a download.
    fastStart: 'in-memory',
  })

  let encodeError: Error | null = null
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => {
      encodeError = error instanceof Error ? error : new Error(String(error))
    },
  })

  encoder.configure({
    codec: candidate.codec,
    width,
    height,
    framerate: fps,
    bitrate,
    latencyMode: 'quality',
  })

  const frameDuration = Math.round(1e6 / fps)
  const report = options.onProgress ?? (() => undefined)

  try {
    for (let index = 0; index < count; index++) {
      if (encodeError) throw encodeError

      const canvas = await renderer.draw(index)
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((index * 1e6) / fps),
        duration: frameDuration,
      })
      // A keyframe every two seconds keeps seeking usable without bloating size.
      encoder.encode(frame, { keyFrame: index % (fps * 2) === 0 })
      frame.close()

      // The encoder queue is bounded so a long render cannot balloon memory.
      if (encoder.encodeQueueSize > 8) await drainTo(encoder, 4)
      report(index + 1, count)
    }

    await encoder.flush()
    if (encodeError) throw encodeError
  } finally {
    if (encoder.state !== 'closed') encoder.close()
  }

  muxer.finalize()
  return { bytes: new Uint8Array(target.buffer), codecLabel: candidate.label }
}

function drainTo(encoder: VideoEncoder, limit: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (encoder.encodeQueueSize <= limit || encoder.state === 'closed') resolve()
      else setTimeout(check, 8)
    }
    check()
  })
}
