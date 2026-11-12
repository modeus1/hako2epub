// Minimal ZIP writer (STORE method) used to produce EPUB archives in the browser.
// EPUB only requires the `mimetype` entry to be stored first and uncompressed;
// storing everything keeps this dependency-free (images are already compressed).

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (0xedb88320 ^ (value >>> 1)) >>> 0 : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

const encoder = new TextEncoder();

/** Zip CRC-32 of the given bytes. */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Turn a string or an ArrayBuffer/view into a Uint8Array. */
function toBytes(value) {
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('toBytes expects a string, ArrayBuffer or typed array');
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function concat(chunks) {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export class ZipWriter {
  constructor() {
    this.entries = [];
  }

  /**
   * Add an entry. Paths must be unique; re-adding the same path replaces the
   * earlier content so callers do not have to guard against duplicates.
   */
  add(name, data) {
    const bytes = toBytes(data);
    const existing = this.entries.find((entry) => entry.name === name);
    if (existing) {
      existing.data = bytes;
      return existing;
    }
    const entry = { name, data: bytes };
    this.entries.push(entry);
    return entry;
  }

  /** Serialise every entry into a complete ZIP archive. */
  build() {
    const { time, date } = dosDateTime(new Date());
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const entry of this.entries) {
      const nameBytes = encoder.encode(entry.name);
      const crc = crc32(entry.data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); // local file header signature
      local.setUint16(4, 20, true); // version needed to extract
      local.setUint16(6, 0x0800, true); // UTF-8 file name flag
      local.setUint16(8, 0, true); // method: store
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, entry.data.length, true);
      local.setUint32(22, entry.data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true); // extra field length

      chunks.push(new Uint8Array(local.buffer), nameBytes, entry.data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); // central directory header signature
      cd.setUint16(4, 20, true); // version made by
      cd.setUint16(6, 20, true); // version needed
      cd.setUint16(8, 0x0800, true); // flags
      cd.setUint16(10, 0, true); // method
      cd.setUint16(12, time, true);
      cd.setUint16(14, date, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, entry.data.length, true);
      cd.setUint32(24, entry.data.length, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint16(30, 0, true); // extra
      cd.setUint16(32, 0, true); // comment
      cd.setUint16(34, 0, true); // disk number start
      cd.setUint16(36, 0, true); // internal attributes
      cd.setUint32(38, 0, true); // external attributes
      cd.setUint32(42, offset, true);

      central.push(new Uint8Array(cd.buffer), nameBytes);
      offset += 30 + nameBytes.length + entry.data.length;
    }

    const centralBytes = concat(central);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); // end of central directory signature
    end.setUint16(4, 0, true);
    end.setUint16(6, 0, true);
    end.setUint16(8, this.entries.length, true);
    end.setUint16(10, this.entries.length, true);
    end.setUint32(12, centralBytes.length, true);
    end.setUint32(16, offset, true);
    end.setUint16(20, 0, true);

    return concat([...chunks, centralBytes, new Uint8Array(end.buffer)]);
  }
}
