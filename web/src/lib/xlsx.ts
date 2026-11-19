// Minimal reader for .xlsx workbooks (Office Open XML: a zip of XML parts), enough for report dumps
// such as the RTO registration lists: the first worksheet's cell values as a grid of strings. No
// dependencies, like lib/xls.ts, and it runs in the browser, so the file never leaves the uploader's
// machine. Numbers come back as plain digits (no exponents), so mobile numbers survive; dates stay as
// Excel serial numbers (see excelDate) because the reader does not look at cell styles.

export class XlsxError extends Error {}

type ZipEntry = { name: string; method: number; compSize: number; size: number; offset: number };

function zipEntries(buf: Uint8Array): Map<string, ZipEntry> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory: signature 0x06054b50 within the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError("Not an .xlsx file. Save the sheet as Excel Workbook (.xlsx) or CSV.");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, ZipEntry>();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== 0x02014b50) throw new XlsxError("Damaged .xlsx file (zip directory).");
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    out.set(name.replace(/^\/+/, ""), { name, method, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function readEntry(buf: Uint8Array, e: ZipEntry): Promise<string> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(e.offset, true) !== 0x04034b50) throw new XlsxError("Damaged .xlsx file (zip entry).");
  const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
  const data = buf.slice(start, start + e.compSize);
  let bytes: Uint8Array;
  if (e.method === 0) bytes = data;
  else if (e.method === 8) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } else throw new XlsxError(`Unsupported .xlsx compression (${e.method}).`);
  return new TextDecoder().decode(bytes);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function unescapeXml(s: string) {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, g: string) => {
    if (g[0] === "#") return String.fromCodePoint(g[1] === "x" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10));
    return ENTITIES[g] ?? m;
  });
}

// Text of every <t> run inside a fragment (rich-text strings carry several), leaving out phonetic runs.
function textRuns(xml: string) {
  let out = "";
  for (const m of xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) out += m[1] ?? "";
  return unescapeXml(out);
}

function colIndex(ref: string) {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function plainNumber(v: string) {
  if (!/e/i.test(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) ? BigInt(n).toString() : v;
}

// Excel serial date (days since 1899-12-30) to YYYY-MM-DD; anything else comes back unchanged.
export function excelDate(v: string): string {
  const t = v.trim();
  if (/^\d{5}(\.\d+)?$/.test(t)) {
    const n = Number(t);
    if (n > 20_000 && n < 80_000) return new Date(Math.round((n - 25_569) * 86_400_000)).toISOString().slice(0, 10);
  }
  return t;
}

// Every sheet of the workbook would be possible; the dumps put everything on the first one.
export async function readXlsx(input: ArrayBuffer | Uint8Array): Promise<string[][]> {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const entries = zipEntries(buf);
  const get = async (path: string) => {
    const e = entries.get(path);
    return e ? readEntry(buf, e) : null;
  };

  // First sheet: workbook.xml names it by relationship id; the rels file gives its path.
  let sheetPath = "xl/worksheets/sheet1.xml";
  const wb = await get("xl/workbook.xml");
  const rels = await get("xl/_rels/workbook.xml.rels");
  const rid = wb?.match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1] ?? wb?.match(/<sheet\b[^>]*\bid="([^"]+)"/)?.[1];
  if (rid && rels) {
    const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => r.includes(`Id="${rid}"`));
    const target = rel?.match(/Target="([^"]+)"/)?.[1];
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }
  const sheet = await get(sheetPath);
  if (sheet === null) throw new XlsxError("The workbook has no worksheet.");

  const shared: string[] = [];
  const sst = await get("xl/sharedStrings.xml");
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) shared.push(m[1] ? textRuns(m[1]) : "");

  const grid: string[][] = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNo = Number(rm[1].match(/\br="(\d+)"/)?.[1] ?? grid.length + 1) - 1;
    const row: string[] = [];
    let next = 0;
    if (rm[2]) {
      for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1];
        const ref = attrs.match(/\br="([A-Z]+)\d*"/)?.[1];
        const col = ref ? colIndex(ref) : next;
        next = col + 1;
        const body = cm[2] ?? "";
        const type = attrs.match(/\bt="([^"]+)"/)?.[1];
        let val = "";
        if (type === "inlineStr") val = textRuns(body);
        else {
          const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
          if (v !== undefined) {
            if (type === "s") val = shared[Number(v)] ?? "";
            else if (type === "str" || type === "e") val = unescapeXml(v);
            else if (type === "b") val = v === "1" ? "TRUE" : "FALSE";
            else val = plainNumber(v);
          }
        }
        while (row.length < col) row.push("");
        row[col] = val;
      }
    }
    while (grid.length < rowNo) grid.push([]);
    grid[rowNo] = row;
  }
  return grid;
}
