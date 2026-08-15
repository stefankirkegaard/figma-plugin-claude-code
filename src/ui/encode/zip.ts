/**
 * Minimal ZIP writer using the "stored" method (no compression).
 *
 * Everything the plugin puts in an archive is already compressed — PNG, JPEG,
 * GIF, MP4 — so deflating would cost CPU for no meaningful size win, and storing
 * keeps this to a few dozen lines with no dependency.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[i] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Packs a JS date into the DOS date/time pair ZIP headers expect. */
function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f),
    date: (((date.getFullYear() - 1980) & 0x7f) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

interface Entry {
  name: string
  bytes: Uint8Array
}

export function makeZip(files: Entry[]): Uint8Array {
  const encoder = new TextEncoder()
  const stamp = dosDateTime(new Date())

  const records = files.map((file) => {
    const name = encoder.encode(file.name)
    return { name, bytes: file.bytes, crc: crc32(file.bytes), offset: 0 }
  })

  const localSize = records.reduce((sum, record) => sum + 30 + record.name.length + record.bytes.length, 0)
  const centralSize = records.reduce((sum, record) => sum + 46 + record.name.length, 0)
  const output = new Uint8Array(localSize + centralSize + 22)
  const view = new DataView(output.buffer)
  let offset = 0

  for (const record of records) {
    record.offset = offset
    view.setUint32(offset, 0x04034b50, true) // local file header
    view.setUint16(offset + 4, 20, true) // version needed
    view.setUint16(offset + 6, 0x0800, true) // UTF-8 filename flag
    view.setUint16(offset + 8, 0, true) // stored
    view.setUint16(offset + 10, stamp.time, true)
    view.setUint16(offset + 12, stamp.date, true)
    view.setUint32(offset + 14, record.crc, true)
    view.setUint32(offset + 18, record.bytes.length, true)
    view.setUint32(offset + 22, record.bytes.length, true)
    view.setUint16(offset + 26, record.name.length, true)
    view.setUint16(offset + 28, 0, true)
    offset += 30
    output.set(record.name, offset)
    offset += record.name.length
    output.set(record.bytes, offset)
    offset += record.bytes.length
  }

  const centralStart = offset
  for (const record of records) {
    view.setUint32(offset, 0x02014b50, true) // central directory header
    view.setUint16(offset + 4, 20, true) // version made by
    view.setUint16(offset + 6, 20, true) // version needed
    view.setUint16(offset + 8, 0x0800, true)
    view.setUint16(offset + 10, 0, true)
    view.setUint16(offset + 12, stamp.time, true)
    view.setUint16(offset + 14, stamp.date, true)
    view.setUint32(offset + 16, record.crc, true)
    view.setUint32(offset + 20, record.bytes.length, true)
    view.setUint32(offset + 24, record.bytes.length, true)
    view.setUint16(offset + 28, record.name.length, true)
    view.setUint16(offset + 30, 0, true) // extra length
    view.setUint16(offset + 32, 0, true) // comment length
    view.setUint16(offset + 34, 0, true) // disk number
    view.setUint16(offset + 36, 0, true) // internal attributes
    view.setUint32(offset + 38, 0, true) // external attributes
    view.setUint32(offset + 42, record.offset, true)
    offset += 46
    output.set(record.name, offset)
    offset += record.name.length
  }

  view.setUint32(offset, 0x06054b50, true) // end of central directory
  view.setUint16(offset + 8, records.length, true)
  view.setUint16(offset + 10, records.length, true)
  view.setUint32(offset + 12, centralSize, true)
  view.setUint32(offset + 16, centralStart, true)

  return output
}
