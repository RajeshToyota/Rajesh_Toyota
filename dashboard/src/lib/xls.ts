// Minimal reader for legacy Excel .xls files (BIFF8 inside an OLE compound file), enough for the
// CTDMS report exports: the first worksheet's cell values as a grid of strings. No dependencies —
// the npm build of SheetJS carries unpatched advisories — and it runs in the browser, so an uploaded
// file is parsed on the uploader's own machine. Dates come back as YYYY-MM-DD, whole numbers
// without exponents (mobile numbers, order ids).

export class XlsError extends Error {}

const END_OF_CHAIN = 0xfffffffe;
const FREE_SECT = 0xffffffff;

function readCompoundStream(buf: Uint8Array, wanted: string[]): Uint8Array {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (buf.length < 512 || sig.some((b, i) => buf[i] !== b)) {
    throw new XlsError("Not an .xls file. Save the report as Excel 97-2003 (.xls) or CSV.");
  }

  const sectorSize = 1 << dv.getUint16(30, true);
  const miniSectorSize = 1 << dv.getUint16(32, true);
  const numFatSectors = dv.getUint32(44, true);
  const firstDirSector = dv.getUint32(48, true);
  const miniCutoff = dv.getUint32(56, true);
  const firstMiniFatSector = dv.getUint32(60, true);
  let difatSector = dv.getUint32(68, true);
  const numDifatSectors = dv.getUint32(72, true);
  if (sectorSize !== 512 && sectorSize !== 4096) throw new XlsError("Unsupported .xls sector size.");

  const sectorOffset = (s: number) => (s + 1) * sectorSize;
  const maxSector = Math.floor(buf.length / sectorSize);

  // FAT sector list: 109 entries in the header, the rest in DIFAT sectors.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < numFatSectors; i++) fatSectors.push(dv.getUint32(76 + i * 4, true));
  for (let n = 0; n < Math.min(numDifatSectors, maxSector) && difatSector < maxSector; n++) {
    const base = sectorOffset(difatSector);
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per && fatSectors.length < numFatSectors; i++) fatSectors.push(dv.getUint32(base + i * 4, true));
    difatSector = dv.getUint32(base + per * 4, true);
  }
  const fat = new Uint32Array(fatSectors.length * (sectorSize / 4));
  fatSectors.forEach((s, i) => {
    if (s >= maxSector) throw new XlsError("Damaged .xls file (FAT).");
    for (let j = 0; j < sectorSize / 4; j++) fat[i * (sectorSize / 4) + j] = dv.getUint32(sectorOffset(s) + j * 4, true);
  });

  const chain = (start: number, table: Uint32Array, limit: number) => {
    const out: number[] = [];
    for (let s = start; s !== END_OF_CHAIN && s !== FREE_SECT; s = table[s]) {
      if (s >= limit || out.length > limit) throw new XlsError("Damaged .xls file (sector chain).");
      out.push(s);
    }
    return out;
  };
  const readChain = (start: number, size: number) => {
    const out = new Uint8Array(size);
    let pos = 0;
    for (const s of chain(start, fat, Math.min(fat.length, maxSector))) {
      const n = Math.min(sectorSize, size - pos);
      if (n <= 0) break;
      out.set(buf.subarray(sectorOffset(s), sectorOffset(s) + n), pos);
      pos += n;
    }
    return out;
  };

  // Directory: 128-byte entries. Entry 0 is the root, which owns the mini stream.
  const dirSectors = chain(firstDirSector, fat, Math.min(fat.length, maxSector));
  const dir = readChain(firstDirSector, dirSectors.length * sectorSize);
  const ddv = new DataView(dir.buffer);
  let root: { start: number; size: number } | null = null;
  let target: { start: number; size: number } | null = null;
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = ddv.getUint16(off + 64, true);
    const type = dir[off + 66];
    if (type === 0 || nameLen < 2) continue;
    let name = "";
    for (let i = 0; i < nameLen / 2 - 1; i++) name += String.fromCharCode(ddv.getUint16(off + i * 2, true));
    const entry = { start: ddv.getUint32(off + 116, true), size: ddv.getUint32(off + 120, true) };
    if (type === 5) root = entry;
    else if (type === 2 && !target && wanted.includes(name)) target = entry;
  }
  if (!target) throw new XlsError("No workbook found in this .xls file.");
  if (target.size >= miniCutoff) return readChain(target.start, target.size);

  // Small stream: lives in the mini stream, addressed through the mini FAT.
  if (!root) throw new XlsError("Damaged .xls file (root entry).");
  const miniStream = readChain(root.start, root.size);
  const miniFatChain = chain(firstMiniFatSector, fat, Math.min(fat.length, maxSector));
  const miniFatBytes = readChain(firstMiniFatSector, miniFatChain.length * sectorSize);
  const miniFat = new Uint32Array(miniFatBytes.buffer, 0, miniFatBytes.length / 4);
  const out = new Uint8Array(target.size);
  let pos = 0;
  for (const s of chain(target.start, miniFat, miniFat.length)) {
    const n = Math.min(miniSectorSize, target.size - pos);
    if (n <= 0) break;
    out.set(miniStream.subarray(s * miniSectorSize, s * miniSectorSize + n), pos);
    pos += n;
  }
  return out;
}

interface BiffRecord {
  type: number;
  data: Uint8Array;
}

function* records(stream: Uint8Array, from = 0): Generator<BiffRecord & { offset: number }> {
  const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  let off = from;
  while (off + 4 <= stream.length) {
    const type = dv.getUint16(off, true);
    const len = dv.getUint16(off + 2, true);
    if (off + 4 + len > stream.length) return;
    yield { type, data: stream.subarray(off + 4, off + 4 + len), offset: off };
    off += 4 + len;
  }
}

const decoder16 = new TextDecoder("utf-16le");
const decoder8 = new TextDecoder("latin1");

// Reads XLUnicodeRichExtendedString pieces that may be split across a record and its CONTINUEs.
// Each CONTINUE that splits the character data starts with a fresh "high byte" flag.
class SegmentReader {
  private seg = 0;
  private pos = 0;
  private segments: Uint8Array[];
  constructor(segments: Uint8Array[]) {
    this.segments = segments;
  }
  private cur() {
    while (this.seg < this.segments.length && this.pos >= this.segments[this.seg].length) {
      this.seg++;
      this.pos = 0;
    }
    if (this.seg >= this.segments.length) throw new XlsError("Damaged .xls file (string table).");
    return this.segments[this.seg];
  }
  u8() {
    return this.cur()[this.pos++];
  }
  u16() {
    return this.u8() | (this.u8() << 8);
  }
  u32() {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }
  skip(n: number) {
    while (n > 0) {
      const s = this.cur();
      const k = Math.min(n, s.length - this.pos);
      this.pos += k;
      n -= k;
    }
  }
  string(): string {
    const cch = this.u16();
    const flags = this.u8();
    let wide = (flags & 1) !== 0;
    const runs = flags & 8 ? this.u16() : 0;
    const ext = flags & 4 ? this.u32() : 0;
    let out = "";
    let left = cch;
    while (left > 0) {
      const s = this.segments[this.seg];
      if (!s) throw new XlsError("Damaged .xls file (string table).");
      const avail = Math.floor((s.length - this.pos) / (wide ? 2 : 1));
      const take = Math.min(left, avail);
      if (take > 0) {
        const bytes = s.subarray(this.pos, this.pos + take * (wide ? 2 : 1));
        out += wide ? decoder16.decode(bytes) : decoder8.decode(bytes);
        this.pos += bytes.length;
        left -= take;
      }
      if (left > 0) {
        // Character data continues in the next segment, which starts with its own flag byte.
        this.seg++;
        this.pos = 0;
        wide = (this.u8() & 1) !== 0;
      }
    }
    this.skip(runs * 4 + ext);
    return out;
  }
}

function shortString(data: Uint8Array, off: number, lenBytes: 1 | 2): string {
  const cch = lenBytes === 2 ? data[off] | (data[off + 1] << 8) : data[off];
  const flags = data[off + lenBytes];
  const start = off + lenBytes + 1;
  return flags & 1
    ? decoder16.decode(data.subarray(start, start + cch * 2))
    : decoder8.decode(data.subarray(start, start + cch));
}

function rkValue(rk: number): number {
  let v: number;
  if (rk & 2) {
    v = rk >> 2;
  } else {
    const b = new DataView(new ArrayBuffer(8));
    b.setUint32(4, rk & 0xfffffffc, true);
    v = b.getFloat64(0, true);
  }
  return rk & 1 ? v / 100 : v;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function isDateFormat(code: string): boolean {
  const stripped = code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "");
  return /[dy]/i.test(stripped) || /m{3,}/i.test(stripped);
}

function formatNumber(n: number, asDate: boolean): string {
  if (asDate && n > 0 && n < 2958466) {
    const ms = Math.round((n - 25569) * 86400000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  if (Number.isInteger(n)) return BigInt(n).toString();
  return String(Math.round(n * 1e10) / 1e10);
}

/** First worksheet of an .xls file as rows of cell strings (empty cells are ""). */
export function readXls(input: ArrayBuffer | Uint8Array): string[][] {
  try {
    return readFirstSheet(input);
  } catch (e) {
    if (e instanceof XlsError) throw e;
    throw new XlsError("This .xls file is damaged or not a CTDMS export.");
  }
}

function readFirstSheet(input: ArrayBuffer | Uint8Array): string[][] {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const stream = readCompoundStream(buf, ["Workbook", "Book"]);

  const sst: string[] = [];
  const dateXf: boolean[] = [];
  const customFormats = new Map<number, string>();
  let firstSheetPos: number | null = null;

  // Workbook globals: string table, formats, cell styles, sheet positions.
  const globals: BiffRecord[] = [];
  for (const r of records(stream)) {
    if (r.type === 0x000a) break; // EOF of globals
    if (r.type === 0x002f) throw new XlsError("This .xls file is password protected. Save it without a password.");
    globals.push(r);
  }
  for (let i = 0; i < globals.length; i++) {
    const { type, data } = globals[i];
    if (type === 0x0809 && i === 0) {
      const ver = data[0] | (data[1] << 8);
      if (ver !== 0x0600) throw new XlsError("Unsupported .xls version. Save the report as Excel 97-2003 (.xls) or CSV.");
    } else if (type === 0x041e) {
      customFormats.set(data[0] | (data[1] << 8), shortString(data, 2, 2));
    } else if (type === 0x00e0) {
      const ifmt = data[2] | (data[3] << 8);
      dateXf.push(BUILTIN_DATE_FORMATS.has(ifmt) || (customFormats.has(ifmt) && isDateFormat(customFormats.get(ifmt)!)));
    } else if (type === 0x0085 && firstSheetPos === null && data[5] === 0) {
      firstSheetPos = (data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)) >>> 0;
    } else if (type === 0x00fc) {
      const segments = [data.subarray(8)];
      while (i + 1 < globals.length && globals[i + 1].type === 0x003c) segments.push(globals[++i].data);
      const total = (data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24)) >>> 0;
      const reader = new SegmentReader(segments);
      for (let n = 0; n < total; n++) sst.push(reader.string());
    }
  }
  if (firstSheetPos === null) throw new XlsError("No worksheet found in this .xls file.");

  // Sparse until the end: a damaged row/column number must not allocate a huge grid.
  // BIFF8 sheets are at most 65,536 rows by 256 columns.
  const cells = new Map<number, Map<number, string>>();
  let cellCount = 0;
  const set = (r: number, c: number, v: string) => {
    if (r > 65535 || c > 255 || ++cellCount > 2_000_000) throw new XlsError("Worksheet is too large.");
    let row = cells.get(r);
    if (!row) cells.set(r, (row = new Map()));
    row.set(c, v);
  };
  const num = (data: Uint8Array, off: number) => new DataView(data.buffer, data.byteOffset + off, 8).getFloat64(0, true);
  const u16 = (d: Uint8Array, o: number) => d[o] | (d[o + 1] << 8);

  let pendingFormula: { r: number; c: number } | null = null;
  for (const { type, data } of records(stream, firstSheetPos)) {
    if (type === 0x000a) break;
    const r = u16(data, 0);
    const c = u16(data, 2);
    const xf = u16(data, 4);
    switch (type) {
      case 0x00fd: // LABELSST
        set(r, c, sst[(data[6] | (data[7] << 8) | (data[8] << 16) | (data[9] << 24)) >>> 0] ?? "");
        break;
      case 0x0204: // LABEL
        set(r, c, shortString(data, 6, 2));
        break;
      case 0x0203: // NUMBER
        set(r, c, formatNumber(num(data, 6), dateXf[xf] ?? false));
        break;
      case 0x027e: // RK
        set(r, c, formatNumber(rkValue((data[6] | (data[7] << 8) | (data[8] << 16) | (data[9] << 24)) >>> 0), dateXf[xf] ?? false));
        break;
      case 0x00bd: { // MULRK
        const last = u16(data, data.length - 2);
        for (let col = c, o = 4; col <= last; col++, o += 6) {
          const cellXf = u16(data, o);
          const rk = (data[o + 2] | (data[o + 3] << 8) | (data[o + 4] << 16) | (data[o + 5] << 24)) >>> 0;
          set(r, col, formatNumber(rkValue(rk), dateXf[cellXf] ?? false));
        }
        break;
      }
      case 0x0205: // BOOLERR
        set(r, c, data[7] === 0 ? (data[6] ? "TRUE" : "FALSE") : "");
        break;
      case 0x0006: // FORMULA: cached result
        if (data[12] === 0xff && data[13] === 0xff) {
          if (data[6] === 0) pendingFormula = { r, c };
          else if (data[6] === 1) set(r, c, data[8] ? "TRUE" : "FALSE");
        } else {
          set(r, c, formatNumber(num(data, 6), dateXf[xf] ?? false));
        }
        break;
      case 0x0207: // STRING (result of the preceding formula)
        if (pendingFormula) set(pendingFormula.r, pendingFormula.c, shortString(data, 0, 2));
        pendingFormula = null;
        break;
    }
  }

  const lastRow = Math.max(-1, ...cells.keys());
  const rows: string[][] = [];
  for (let r = 0; r <= lastRow; r++) {
    const row = cells.get(r);
    const out: string[] = [];
    if (row) for (const [c, v] of row) {
      while (out.length < c) out.push("");
      out[c] = v;
    }
    rows.push(out);
  }
  return rows;
}
