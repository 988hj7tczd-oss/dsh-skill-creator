/**
 * Minimal ZIP archive support (store method, no compression) so `.skill`
 * packaging and verification work offline with zero npm dependencies.
 *
 * Implements the classic ZIP layout: local file headers, a central directory
 * and the end-of-central-directory record. Names are encoded as UTF-8 with the
 * language encoding flag set. Directory entries carry an empty payload.
 */

const LOCAL_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50
const VERSION_NEEDED = 20
const ENCODING_FLAG = 0x0800 // bit 11: UTF-8 names

export interface ZipEntry {
  readonly name: string
  readonly data: Uint8Array
}

interface CentralEntry {
  readonly name: string
  readonly method: number
  readonly crc: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localOffset: number
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let value = n
    for (let k = 0; k < 8; k += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[n] = value >>> 0
  }
  return table
})()

/** CRC-32 of a byte buffer. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

const encoder = new TextEncoder()

function encodeName(name: string): Uint8Array {
  return encoder.encode(name)
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true)
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true)
}

/**
 * Build a ZIP archive from entries. Directory entries (name ending in '/')
 * must be provided explicitly when wanted; their payload is empty.
 */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  const centralOffsets: number[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = encodeName(entry.name)
    const crc = crc32(entry.data)
    const size = entry.data.length
    const local = new Uint8Array(30 + nameBuf.length + size)
    const view = new DataView(local.buffer)

    writeUint32(view, 0, LOCAL_HEADER_SIGNATURE)
    writeUint16(view, 4, VERSION_NEEDED)
    writeUint16(view, 6, ENCODING_FLAG)
    writeUint16(view, 8, 0) // method: store
    writeUint16(view, 10, 0) // mod time
    writeUint16(view, 12, 0) // mod date
    writeUint32(view, 14, crc)
    writeUint32(view, 18, size)
    writeUint32(view, 22, size)
    writeUint16(view, 26, nameBuf.length)
    writeUint16(view, 28, 0) // extra length
    local.set(nameBuf, 30)
    local.set(entry.data, 30 + nameBuf.length)
    localParts.push(local)
    centralOffsets.push(offset)
    offset += local.length
  }

  const centralStart = offset
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!
    const nameBuf = encodeName(entry.name)
    const crc = crc32(entry.data)
    const size = entry.data.length
    const record = new Uint8Array(46 + nameBuf.length)
    const view = new DataView(record.buffer)

    writeUint32(view, 0, CENTRAL_HEADER_SIGNATURE)
    writeUint16(view, 4, VERSION_NEEDED)
    writeUint16(view, 6, VERSION_NEEDED)
    writeUint16(view, 8, ENCODING_FLAG)
    writeUint16(view, 10, 0) // method: store
    writeUint16(view, 12, 0) // mod time
    writeUint16(view, 14, 0) // mod date
    writeUint32(view, 16, crc)
    writeUint32(view, 20, size)
    writeUint32(view, 24, size)
    writeUint16(view, 28, nameBuf.length)
    writeUint16(view, 30, 0) // extra
    writeUint16(view, 32, 0) // comment
    writeUint16(view, 34, 0) // disk number start
    writeUint16(view, 36, 0) // internal attributes
    writeUint32(view, 38, 0) // external attributes
    writeUint32(view, 42, centralOffsets[i]!)
    record.set(nameBuf, 46)
    centralParts.push(record)
    offset += record.length
  }

  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  writeUint32(eocdView, 0, EOCD_SIGNATURE)
  writeUint16(eocdView, 4, 0) // disk number
  writeUint16(eocdView, 6, 0) // central dir disk
  writeUint16(eocdView, 8, entries.length)
  writeUint16(eocdView, 10, entries.length)
  writeUint32(eocdView, 12, offset - centralStart)
  writeUint32(eocdView, 16, centralStart)
  writeUint16(eocdView, 20, 0) // comment length

  const total = new Uint8Array(offset + 22)
  let cursor = 0
  for (const part of localParts) {
    total.set(part, cursor)
    cursor += part.length
  }
  for (const part of centralParts) {
    total.set(part, cursor)
    cursor += part.length
  }
  total.set(eocd, cursor)
  return total
}

const decoder = new TextDecoder()

/**
 * Read a ZIP archive produced by {@link buildZip} (store method only).
 * Returns a map from entry name to payload bytes.
 */
export function readZip(data: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const eocdIndex = findEocd(view)
  if (eocdIndex < 0) throw new Error('readZip: end-of-central-directory not found')

  const count = view.getUint16(eocdIndex + 10, true)
  const centralSize = view.getUint32(eocdIndex + 12, true)
  const centralOffset = view.getUint32(eocdIndex + 16, true)

  const central = new DataView(data.buffer, data.byteOffset + centralOffset, centralSize)
  const entries: CentralEntry[] = []
  let cursor = 0
  for (let i = 0; i < count; i += 1) {
    if (central.getUint32(cursor, true) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error('readZip: malformed central directory')
    }
    const method = central.getUint16(cursor + 10, true)
    if (method !== 0) throw new Error(`readZip: unsupported compression method ${method}`)
    const crc = central.getUint32(cursor + 16, true)
    const compressedSize = central.getUint32(cursor + 20, true)
    const uncompressedSize = central.getUint32(cursor + 24, true)
    const nameLength = central.getUint16(cursor + 28, true)
    const extraLength = central.getUint16(cursor + 30, true)
    const commentLength = central.getUint16(cursor + 32, true)
    const localOffset = central.getUint32(cursor + 42, true)
    const nameBytes = new Uint8Array(data.buffer, data.byteOffset + centralOffset + cursor + 46, nameLength)
    const name = decoder.decode(nameBytes)
    entries.push({ name, method, crc, compressedSize, uncompressedSize, localOffset })
    cursor += 46 + nameLength + extraLength + commentLength
  }

  const result = new Map<string, Uint8Array>()
  for (const entry of entries) {
    if (entry.name.endsWith('/')) {
      result.set(entry.name, new Uint8Array(0))
      continue
    }
    const local = new DataView(data.buffer, data.byteOffset + entry.localOffset)
    if (local.getUint32(0, true) !== LOCAL_HEADER_SIGNATURE) {
      throw new Error(`readZip: bad local header for ${entry.name}`)
    }
    const nameLength = local.getUint16(26, true)
    const extraLength = local.getUint16(28, true)
    const start = 30 + nameLength + extraLength
    result.set(entry.name, new Uint8Array(data.buffer, data.byteOffset + entry.localOffset + start, entry.compressedSize))
  }
  return result
}

function findEocd(view: DataView): number {
  if (view.byteLength < 22) return -1
  const maxScan = Math.min(view.byteLength - 22, 65535)
  for (let i = view.byteLength - 22; i >= view.byteLength - 22 - maxScan; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i
  }
  return -1
}