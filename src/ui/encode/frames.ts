import { asBlobPart } from '../dom'

/**
 * Holds the PNG frames streamed over from the plugin sandbox.
 *
 * Frames are kept as PNG blobs rather than decoded pixels: a 1080p RGBA buffer
 * is ~8 MB, so a few hundred of them would exhaust the iframe's memory, while
 * the encoded PNGs are typically a few hundred kB each and decode on demand.
 */
export class FrameStore {
  private blobs: Blob[] = []

  constructor(
    public readonly sourceWidth: number,
    public readonly sourceHeight: number,
  ) {}

  add(bytes: Uint8Array): void {
    // The Blob copies the bytes, so the incoming array can be released.
    this.blobs.push(new Blob([asBlobPart(bytes)], { type: 'image/png' }))
  }

  get count(): number {
    return this.blobs.length
  }

  get totalBytes(): number {
    return this.blobs.reduce((sum, blob) => sum + blob.size, 0)
  }

  blobAt(index: number): Blob {
    return this.blobs[index]
  }

  bytesAt(index: number): Promise<Uint8Array> {
    return this.blobs[index].arrayBuffer().then((buffer) => new Uint8Array(buffer))
  }

  bitmap(index: number): Promise<ImageBitmap> {
    return createImageBitmap(this.blobs[index])
  }

  clear(): void {
    this.blobs = []
  }
}

/**
 * Composites stored frames onto a fixed-size canvas.
 *
 * Frames in a sequence can have different dimensions (a 375×812 screen morphing
 * into a 375×900 one), and video codecs need every frame at one even-numbered
 * size — so each frame is scaled to fit and centred on a constant canvas.
 */
export class FrameRenderer {
  readonly canvas: HTMLCanvasElement
  private readonly context: CanvasRenderingContext2D

  constructor(
    private readonly store: FrameStore,
    readonly width: number,
    readonly height: number,
    private readonly background: string | null,
  ) {
    this.canvas = document.createElement('canvas')
    this.canvas.width = width
    this.canvas.height = height
    const context = this.canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('This browser would not give the plugin a 2D canvas.')
    this.context = context
    this.context.imageSmoothingEnabled = true
    this.context.imageSmoothingQuality = 'high'
  }

  async draw(index: number): Promise<HTMLCanvasElement> {
    const bitmap = await this.store.bitmap(index)
    const { context, width, height } = this

    context.clearRect(0, 0, width, height)
    if (this.background) {
      context.fillStyle = this.background
      context.fillRect(0, 0, width, height)
    }

    const scale = Math.min(width / bitmap.width, height / bitmap.height)
    const drawWidth = bitmap.width * scale
    const drawHeight = bitmap.height * scale
    context.drawImage(bitmap, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight)
    bitmap.close()
    return this.canvas
  }

  async imageData(index: number): Promise<ImageData> {
    await this.draw(index)
    return this.context.getImageData(0, 0, this.width, this.height)
  }
}

/** Video encoders reject odd dimensions, so sizes are rounded down to even. */
export function evenSize(width: number, height: number): { width: number; height: number } {
  return { width: Math.max(2, Math.floor(width / 2) * 2), height: Math.max(2, Math.floor(height / 2) * 2) }
}

/** Scales `width`×`height` so its longest edge is at most `limit`. */
export function fitWithin(width: number, height: number, limit: number): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= limit) return { width, height }
  const scale = limit / longest
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}
