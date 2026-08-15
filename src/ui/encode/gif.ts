/**
 * A self-contained GIF89a encoder.
 *
 * Written by hand rather than pulled from a library because the plugin ships as
 * a single inlined HTML file with no network access, and the usual GIF packages
 * expect to spin up worker scripts from a URL.
 *
 * The pipeline is: sample colours across every frame → median-cut them into a
 * shared palette → map each frame onto that palette (optionally with
 * Floyd-Steinberg dithering) → LZW-compress each frame, cropped to the region
 * that actually changed.
 */

export interface GifOptions {
  width: number
  height: number
  fps: number
  loop: boolean
  dither: boolean
  /** Palette size, 2-256. One slot is reserved when the frames have transparency. */
  colors: number
  onProgress?: (done: number, total: number) => void
}

type FrameSource = (index: number) => Promise<ImageData>

class ByteWriter {
  private bytes = new Uint8Array(1 << 16)
  private length = 0

  private ensure(extra: number): void {
    if (this.length + extra <= this.bytes.length) return
    let capacity = this.bytes.length * 2
    while (capacity < this.length + extra) capacity *= 2
    const next = new Uint8Array(capacity)
    next.set(this.bytes.subarray(0, this.length))
    this.bytes = next
  }

  byte(value: number): void {
    this.ensure(1)
    this.bytes[this.length++] = value & 0xff
  }

  u16(value: number): void {
    this.ensure(2)
    this.bytes[this.length++] = value & 0xff
    this.bytes[this.length++] = (value >> 8) & 0xff
  }

  raw(values: Uint8Array | number[]): void {
    this.ensure(values.length)
    this.bytes.set(values as Uint8Array, this.length)
    this.length += values.length
  }

  ascii(value: string): void {
    for (let i = 0; i < value.length; i++) this.byte(value.charCodeAt(i))
  }

  finish(): Uint8Array {
    return this.bytes.slice(0, this.length)
  }
}

/* ------------------------------------------------------------- quantizing */

interface Range {
  start: number
  end: number
}

/**
 * Median cut: repeatedly split the colour box with the widest channel spread at
 * its median, then average each resulting box. Cheap, deterministic, and good
 * enough for UI animation where colours are flat.
 */
function medianCut(samples: Uint8Array, sampleCount: number, maxColors: number): Uint8Array {
  const order = new Uint32Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) order[i] = i

  let boxes: Range[] = [{ start: 0, end: sampleCount }]

  while (boxes.length < maxColors) {
    let bestIndex = -1
    let bestScore = 0
    let bestAxis = 0

    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]
      if (box.end - box.start < 2) continue
      const { axis, extent } = widestAxis(samples, order, box)
      const score = extent * (box.end - box.start)
      if (score > bestScore) {
        bestScore = score
        bestIndex = i
        bestAxis = axis
      }
    }
    if (bestIndex === -1) break

    const box = boxes[bestIndex]
    sortRange(samples, order, box, bestAxis)
    const middle = (box.start + box.end) >> 1
    boxes.splice(bestIndex, 1, { start: box.start, end: middle }, { start: middle, end: box.end })
  }

  const palette = new Uint8Array(boxes.length * 3)
  boxes.forEach((box, index) => {
    let r = 0
    let g = 0
    let b = 0
    const count = Math.max(1, box.end - box.start)
    for (let i = box.start; i < box.end; i++) {
      const offset = order[i] * 3
      r += samples[offset]
      g += samples[offset + 1]
      b += samples[offset + 2]
    }
    palette[index * 3] = Math.round(r / count)
    palette[index * 3 + 1] = Math.round(g / count)
    palette[index * 3 + 2] = Math.round(b / count)
  })
  return palette
}

function widestAxis(samples: Uint8Array, order: Uint32Array, box: Range): { axis: number; extent: number } {
  const min = [255, 255, 255]
  const max = [0, 0, 0]
  for (let i = box.start; i < box.end; i++) {
    const offset = order[i] * 3
    for (let axis = 0; axis < 3; axis++) {
      const value = samples[offset + axis]
      if (value < min[axis]) min[axis] = value
      if (value > max[axis]) max[axis] = value
    }
  }
  // Weighted for perceived brightness so green splits win ties over blue.
  const spreads = [(max[0] - min[0]) * 0.9, (max[1] - min[1]) * 1.1, (max[2] - min[2]) * 0.7]
  let axis = 0
  if (spreads[1] > spreads[axis]) axis = 1
  if (spreads[2] > spreads[axis]) axis = 2
  return { axis, extent: max[axis] - min[axis] }
}

function sortRange(samples: Uint8Array, order: Uint32Array, box: Range, axis: number): void {
  const slice = Array.from(order.subarray(box.start, box.end))
  slice.sort((a, b) => samples[a * 3 + axis] - samples[b * 3 + axis])
  order.set(slice, box.start)
}

/** 15-bit RGB cache in front of the nearest-colour search, which is the hot path. */
class PaletteMapper {
  private cache = new Int16Array(32768).fill(-1)

  constructor(private palette: Uint8Array, private count: number) {}

  lookup(r: number, g: number, b: number): number {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    const cached = this.cache[key]
    if (cached >= 0) return cached

    let best = 0
    let bestDistance = Infinity
    for (let i = 0; i < this.count; i++) {
      const dr = r - this.palette[i * 3]
      const dg = g - this.palette[i * 3 + 1]
      const db = b - this.palette[i * 3 + 2]
      const distance = dr * dr * 0.9 + dg * dg * 1.1 + db * db * 0.7
      if (distance < bestDistance) {
        bestDistance = distance
        best = i
        if (distance === 0) break
      }
    }
    this.cache[key] = best
    return best
  }

  color(index: number): [number, number, number] {
    return [this.palette[index * 3], this.palette[index * 3 + 1], this.palette[index * 3 + 2]]
  }
}

function quantizeFrame(
  image: ImageData,
  mapper: PaletteMapper,
  transparentIndex: number,
  dither: boolean,
): Uint8Array {
  const { width, height, data } = image
  const indices = new Uint8Array(width * height)

  if (!dither) {
    for (let pixel = 0, offset = 0; pixel < indices.length; pixel++, offset += 4) {
      indices[pixel] =
        transparentIndex >= 0 && data[offset + 3] < 128
          ? transparentIndex
          : mapper.lookup(data[offset], data[offset + 1], data[offset + 2])
    }
    return indices
  }

  // Floyd-Steinberg: errors are carried in two row buffers rather than mutating
  // the source, so the caller's ImageData stays reusable.
  let current = new Int16Array(width * 3)
  let next = new Int16Array(width * 3)

  for (let y = 0; y < height; y++) {
    next.fill(0)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      const pixel = y * width + x

      if (transparentIndex >= 0 && data[offset + 3] < 128) {
        indices[pixel] = transparentIndex
        continue
      }

      const r = clamp255(data[offset] + current[x * 3])
      const g = clamp255(data[offset + 1] + current[x * 3 + 1])
      const b = clamp255(data[offset + 2] + current[x * 3 + 2])
      const index = mapper.lookup(r, g, b)
      indices[pixel] = index

      const [pr, pg, pb] = mapper.color(index)
      const errors = [r - pr, g - pg, b - pb]
      for (let channel = 0; channel < 3; channel++) {
        const error = errors[channel]
        if (error === 0) continue
        if (x + 1 < width) current[(x + 1) * 3 + channel] += (error * 7) >> 4
        if (x > 0) next[(x - 1) * 3 + channel] += (error * 3) >> 4
        next[x * 3 + channel] += (error * 5) >> 4
        if (x + 1 < width) next[(x + 1) * 3 + channel] += error >> 4
      }
    }
    const swap = current
    current = next
    next = swap
  }
  return indices
}

function clamp255(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value
}

/* ------------------------------------------------------------------- LZW */

function lzwCompress(writer: ByteWriter, indices: Uint8Array, minCodeSize: number): void {
  const clearCode = 1 << minCodeSize
  const endCode = clearCode + 1

  let codeSize = minCodeSize + 1
  let nextCode = endCode + 1
  let dictionary = new Map<number, number>()

  const block: number[] = []
  let bitBuffer = 0
  let bitCount = 0

  const flushBlock = () => {
    while (block.length > 0) {
      const chunk = block.splice(0, 255)
      writer.byte(chunk.length)
      writer.raw(chunk)
    }
  }

  const emit = (code: number) => {
    bitBuffer |= code << bitCount
    bitCount += codeSize
    while (bitCount >= 8) {
      block.push(bitBuffer & 0xff)
      bitBuffer >>= 8
      bitCount -= 8
      if (block.length >= 255) {
        writer.byte(255)
        writer.raw(block.splice(0, 255))
      }
    }
  }

  writer.byte(minCodeSize)
  emit(clearCode)

  if (indices.length > 0) {
    let prefix = indices[0]
    for (let i = 1; i < indices.length; i++) {
      const suffix = indices[i]
      const key = (prefix << 8) | suffix
      const existing = dictionary.get(key)
      if (existing !== undefined) {
        prefix = existing
        continue
      }

      emit(prefix)

      // The decoder only learns about a dictionary entry when it reads the code
      // *after* the one that created it, so it is always one entry behind. The
      // width therefore has to grow here — after emitting, before the entry is
      // assigned — or the decoder reads the following code at the wrong width
      // and the rest of the stream is garbage.
      if (nextCode >= 1 << codeSize && codeSize < 12) codeSize++

      if (nextCode >= 4096) {
        // The dictionary is full: reset both sides and start over.
        emit(clearCode)
        dictionary = new Map()
        codeSize = minCodeSize + 1
        nextCode = endCode + 1
      } else {
        dictionary.set(key, nextCode++)
      }
      prefix = suffix
    }
    emit(prefix)
  }

  emit(endCode)
  if (bitCount > 0) block.push(bitBuffer & 0xff)
  flushBlock()
  writer.byte(0) // block terminator
}

/* ------------------------------------------------------------- the encoder */

interface DirtyRect {
  left: number
  top: number
  width: number
  height: number
}

/** Smallest rectangle covering every pixel that differs from the previous frame. */
function dirtyRect(current: Uint8Array, previous: Uint8Array | null, width: number, height: number): DirtyRect {
  if (!previous) return { left: 0, top: 0, width, height }

  let left = width
  let right = -1
  let top = height
  let bottom = -1

  for (let y = 0; y < height; y++) {
    const rowStart = y * width
    for (let x = 0; x < width; x++) {
      if (current[rowStart + x] === previous[rowStart + x]) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }

  // Identical frames still need an image block; a single pixel is the cheapest.
  if (right === -1) return { left: 0, top: 0, width: 1, height: 1 }
  return { left, top, width: right - left + 1, height: bottom - top + 1 }
}

function cropIndices(indices: Uint8Array, width: number, rect: DirtyRect): Uint8Array {
  if (rect.left === 0 && rect.top === 0 && rect.width === width) {
    return indices.subarray(0, rect.width * rect.height)
  }
  const out = new Uint8Array(rect.width * rect.height)
  for (let y = 0; y < rect.height; y++) {
    const from = (rect.top + y) * width + rect.left
    out.set(indices.subarray(from, from + rect.width), y * rect.width)
  }
  return out
}

export async function encodeGif(count: number, getFrame: FrameSource, options: GifOptions): Promise<Uint8Array> {
  if (count === 0) throw new Error('There are no frames to encode.')
  const { width, height, fps } = options
  const report = options.onProgress ?? (() => undefined)

  /* Pass 1 — sample colours and detect transparency. */
  const perFrame = Math.max(1, Math.floor(120000 / count))
  const samples = new Uint8Array(Math.min(count * perFrame, 300000) * 3)
  let sampleCount = 0
  let hasAlpha = false

  for (let index = 0; index < count; index++) {
    const image = await getFrame(index)
    const pixels = image.width * image.height
    const stride = Math.max(1, Math.floor(pixels / perFrame))
    for (let pixel = 0; pixel < pixels && sampleCount * 3 < samples.length; pixel += stride) {
      const offset = pixel * 4
      if (image.data[offset + 3] < 128) {
        hasAlpha = true
        continue
      }
      samples[sampleCount * 3] = image.data[offset]
      samples[sampleCount * 3 + 1] = image.data[offset + 1]
      samples[sampleCount * 3 + 2] = image.data[offset + 2]
      sampleCount++
    }
    report(index + 1, count * 2)
  }

  const requested = Math.max(2, Math.min(256, Math.floor(options.colors)))
  const maxColors = hasAlpha ? requested - 1 : requested
  const palette = sampleCount > 0 ? medianCut(samples, sampleCount, maxColors) : new Uint8Array([0, 0, 0])
  const paletteCount = palette.length / 3
  const transparentIndex = hasAlpha ? paletteCount : -1
  const entryCount = hasAlpha ? paletteCount + 1 : paletteCount

  let tableBits = 1
  while (1 << tableBits < entryCount) tableBits++
  const tableSize = 1 << tableBits
  const mapper = new PaletteMapper(palette, paletteCount)

  /* Pass 2 — quantize and compress. */
  const writer = new ByteWriter()
  writer.ascii('GIF89a')
  writer.u16(width)
  writer.u16(height)
  writer.byte(0x80 | 0x70 | (tableBits - 1)) // global table, 8-bit colour resolution
  writer.byte(0)
  writer.byte(0)

  const table = new Uint8Array(tableSize * 3)
  table.set(palette.subarray(0, paletteCount * 3))
  writer.raw(table)

  if (options.loop) {
    writer.byte(0x21)
    writer.byte(0xff)
    writer.byte(11)
    writer.ascii('NETSCAPE2.0')
    writer.byte(3)
    writer.byte(1)
    writer.u16(0) // 0 = loop forever
    writer.byte(0)
  }

  const minCodeSize = Math.max(2, tableBits)
  let previous: Uint8Array | null = null

  for (let index = 0; index < count; index++) {
    const image = await getFrame(index)
    const indices = quantizeFrame(image, mapper, transparentIndex, options.dither)

    // Transparent frames must fully repaint, otherwise earlier frames show
    // through the holes; opaque frames can ship just the changed rectangle.
    const rect = hasAlpha ? { left: 0, top: 0, width, height } : dirtyRect(indices, previous, width, height)
    const cropped = cropIndices(indices, width, rect)

    // GIF delays are whole centiseconds, so the rounding error is carried
    // forward to keep total playback length honest.
    const delay = Math.round(((index + 1) * 100) / fps) - Math.round((index * 100) / fps)

    writer.byte(0x21) // graphic control extension
    writer.byte(0xf9)
    writer.byte(4)
    writer.byte((hasAlpha ? 2 << 2 : 1 << 2) | (hasAlpha ? 1 : 0))
    writer.u16(Math.max(1, delay))
    writer.byte(hasAlpha ? transparentIndex : 0)
    writer.byte(0)

    writer.byte(0x2c) // image descriptor
    writer.u16(rect.left)
    writer.u16(rect.top)
    writer.u16(rect.width)
    writer.u16(rect.height)
    writer.byte(0) // no local colour table

    lzwCompress(writer, cropped, minCodeSize)

    previous = indices
    report(count + index + 1, count * 2)
  }

  writer.byte(0x3b) // trailer
  return writer.finish()
}
