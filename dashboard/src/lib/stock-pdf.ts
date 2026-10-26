// Reads the CTDMS "Stock Statement" PDF (Transit or Physical Stock) into rows. The report is a
// fixed-layout table: every vehicle row is anchored on its Sr. No. and VIN, column headers are
// repeated on each page, and long values (model "URBAN CRUISER / HYRYDER", company names) wrap onto a
// line just above and below the row. So each text item is placed in the column whose header centre
// is nearest, and in the row whose anchor line is nearest.
//
// parseStockStatement() is pure (text items in, rows out) so it can be tested without a browser;
// readStockPdf() extracts the items with pdf.js in the browser.

export interface TextItem {
  str: string;
  x: number;
  y: number; // PDF user space: larger is higher on the page
  w: number;
}

export interface StockRow {
  sr: number;
  vin: string;
  vin_raw: string;
  engine_no: string | null;
  key_no: string | null;
  model: string | null;
  grade: string | null;
  suffix_code: string | null;
  ext_color: string | null;
  int_color: string | null;
  days_since_invoice: number | null;
  invoice_amount: number | null;
  interest_amount: number | null;
  billing_desc: string | null;
  block_status: string | null; // Free | Blocked | Alloted
  customer_name: string | null;
  sales_officer: string | null;
  order_no: string | null;
  order_date: string | null; // ISO
  order_status: string | null;
  block_ageing: number | null;
  pds_done: boolean | null;
  amount_received: number | null;
  finance_company: string | null;
  likely_delivery: string | null; // ISO
  location: string | null;
}

export interface StockStatement {
  source: "transit" | "physical";
  reportDate: string | null; // ISO date the report was printed
  dealerName: string | null;
  dealerCode: string | null;
  totalVehicles: number | null;
  rows: StockRow[];
  warnings: string[];
}

type Key =
  | "sr" | "dealer" | "vin" | "engine" | "key" | "model" | "grade" | "suffix" | "ext_color" | "int_color"
  | "days" | "invoice_amount" | "interest" | "billing" | "status" | "customer" | "so" | "order_no"
  | "order_date" | "order_status" | "block_ageing" | "pds" | "received" | "finance" | "outstanding"
  | "ldd" | "location" | "acc" | "flag";

const HEADERS: [RegExp, Key[]][] = [
  [/^sr\.? ?no\.?$/, ["sr"]],
  [/^dealer display name$/, ["dealer"]],
  [/^vin no\.?$/, ["vin"]],
  [/^engine no\.?$/, ["engine"]],
  [/^key no\.?$/, ["key"]],
  [/^model$/, ["model"]],
  [/^grade$/, ["grade"]],
  [/^suffix code$/, ["suffix"]],
  [/^ext\.? colou?r description$/, ["ext_color"]],
  [/^int\.? colou?r description$/, ["int_color"]],
  [/^days since tkm\/?$/, ["days"]],
  [/^tkm\/dst invoice amount$/, ["invoice_amount"]],
  [/^interest amount$/, ["interest"]],
  [/^billing desc(ription)?$/, ["billing"]],
  [/^vehicle status$/, ["status"]],
  [/^customer name$/, ["customer"]],
  [/^sales officer$/, ["so"]],
  [/^order no\.?$/, ["order_no"]],
  [/^order date$/, ["order_date"]],
  [/^order status$/, ["order_status"]],
  [/^block ageing pds done$/, ["block_ageing", "pds"]],
  [/^block ageing$/, ["block_ageing"]],
  [/^pds done$/, ["pds"]],
  [/^amount received$/, ["received"]],
  [/^finance ?company$/, ["finance"]],
  [/^outstanding amount$/, ["outstanding"]],
  [/^(likely delivery date|ldd)$/, ["ldd"]],
  [/^location$/, ["location"]],
  [/^acc\??$/, ["acc"]],
  [/^flag for stock( locator)?$/, ["flag"]],
];

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const num = (s: string | undefined) => {
  if (!s) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const int = (s: string | undefined) => {
  const n = num(s);
  return n === null ? null : Math.round(n);
};
// CTDMS prints order dates as MM/DD/YYYY and delivery dates as DD/MM/YYYY.
const isoFrom = (s: string | undefined, order: "mdy" | "dmy") => {
  const m = s?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [a, b, y] = [Number(m[1]), Number(m[2]), m[3]];
  const [mm, dd] = order === "mdy" ? [a, b] : [b, a];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${y}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
};
const text = (s: string | undefined) => (s && s.trim() ? norm(s) : null);

interface Column {
  key: Key;
  centre: number;
}

// Header items sit on two or three lines just around the "Sr. No." label. Words of one header can be
// separate items ("Interest" "Amount"), so neighbouring items on a line are joined first.
function headerColumns(items: TextItem[], srY: number): Column[] {
  const band = items.filter((i) => i.y <= srY + 2 && i.y >= srY - 8);
  const lines = new Map<number, TextItem[]>();
  for (const it of band) {
    const key = [...lines.keys()].find((y) => Math.abs(y - it.y) <= 2) ?? it.y;
    lines.set(key, [...(lines.get(key) ?? []), it]);
  }
  const headerOf = (s: string) => HEADERS.find(([re]) => re.test(norm(s).toLowerCase()))?.[1];
  const cols: Column[] = [];
  const emit = (h: TextItem, keys: Key[]) =>
    keys.forEach((key, i) => cols.push({ key, centre: h.x + (h.w * (2 * i + 1)) / (2 * keys.length) }));
  for (const line of lines.values()) {
    line.sort((a, b) => a.x - b.x);
    // A complete header on its own is never merged; leftover words are joined with their
    // close neighbours until they make a header.
    let pending = null as TextItem | null;
    for (const it of line.filter((i) => i.str.trim())) {
      const own = headerOf(it.str);
      if (own) {
        pending = null;
        emit(it, own);
        continue;
      }
      if (pending && it.x - (pending.x + pending.w) < 14) {
        pending = { ...pending, str: `${pending.str} ${it.str}`, w: it.x + it.w - pending.x };
      } else pending = { ...it };
      const joined = headerOf(pending.str);
      if (joined) {
        emit(pending, joined);
        pending = null;
      }
    }
  }
  return cols;
}

function parsePage(items: TextItem[], warnings: string[], pageNo: number): StockRow[] {
  const srHeader = items.find((i) => /^sr\.? ?no\.?$/i.test(norm(i.str)));
  if (!srHeader) return [];
  const cols = headerColumns(items, srHeader.y);
  const colOf = (it: TextItem) => {
    const mid = it.x + it.w / 2;
    let best: Column | null = null;
    for (const c of cols) if (!best || Math.abs(c.centre - mid) < Math.abs(best.centre - mid)) best = c;
    return best?.key ?? null;
  };
  const srCol = cols.find((c) => c.key === "sr");
  const vinCol = cols.find((c) => c.key === "vin");
  if (!srCol || !vinCol) {
    warnings.push(`Page ${pageNo}: column headers not recognised`);
    return [];
  }

  const body = items.filter((i) => i.y < srHeader.y - 9 && i.str.trim());
  const vinRe = /^[A-HJ-NPR-Z0-9]{17}(~\d{4})?$/;
  const anchors = body
    .filter((i) => /^\d+$/.test(i.str.trim()) && colOf(i) === "sr")
    .map((sr) => ({ sr, vin: body.find((v) => Math.abs(v.y - sr.y) <= 2 && vinRe.test(v.str.trim())) }))
    .filter((a): a is { sr: TextItem; vin: TextItem } => !!a.vin)
    .sort((a, b) => b.sr.y - a.sr.y);

  const cells = anchors.map(() => new Map<Key, TextItem[]>());
  for (const it of body) {
    if (!anchors.length) break;
    let best = 0;
    for (let i = 1; i < anchors.length; i++) {
      if (Math.abs(anchors[i].sr.y - it.y) < Math.abs(anchors[best].sr.y - it.y)) best = i;
    }
    if (Math.abs(anchors[best].sr.y - it.y) > 16) continue;
    const key = colOf(it);
    if (!key) continue;
    const m = cells[best];
    m.set(key, [...(m.get(key) ?? []), it]);
  }

  return anchors.map((a, i) => {
    const m = cells[i];
    const get = (k: Key) => {
      const parts = (m.get(k) ?? []).sort((p, q) => q.y - p.y || p.x - q.x);
      return parts.length ? norm(parts.map((p) => p.str).join(" ")) : undefined;
    };
    const vinRaw = a.vin.str.trim();
    const pds = get("pds");
    return {
      sr: Number(a.sr.str.trim()),
      vin: vinRaw.split("~")[0],
      vin_raw: vinRaw,
      engine_no: text(get("engine")),
      key_no: text(get("key")),
      model: text(get("model")),
      grade: text(get("grade")),
      suffix_code: text(get("suffix")),
      ext_color: text(get("ext_color")),
      int_color: text(get("int_color")),
      days_since_invoice: int(get("days")),
      invoice_amount: num(get("invoice_amount")),
      interest_amount: num(get("interest")),
      billing_desc: text(get("billing")),
      block_status: text(get("status")),
      customer_name: text(get("customer")),
      sales_officer: text(get("so")),
      order_no: text(get("order_no")),
      order_date: isoFrom(get("order_date"), "mdy"),
      order_status: text(get("order_status")),
      block_ageing: int(get("block_ageing")),
      pds_done: pds ? /^y/i.test(pds) : null,
      amount_received: num(get("received")),
      finance_company: text(get("finance")),
      likely_delivery: isoFrom(get("ldd"), "dmy"),
      location: text(get("location")),
    };
  });
}

// The value printed to the right of a label on the report's header lines ("Dealer:", "Date:").
function labelValue(items: TextItem[], label: RegExp): string | null {
  const l = items.find((i) => label.test(norm(i.str)));
  if (!l) return null;
  const right = items
    .filter((i) => Math.abs(i.y - l.y) <= 2 && i.x > l.x)
    .sort((a, b) => a.x - b.x)[0];
  if (right) return norm(right.str);
  // A value can be printed just above/below its label (Physical "Total Vehicles:").
  const near = items
    .filter((i) => Math.abs(i.y - l.y) <= 6 && i.x > l.x && i.x < l.x + 200 && i !== l)
    .sort((a, b) => a.x - b.x)[0];
  return near ? norm(near.str) : null;
}

export function parseStockStatement(pages: TextItem[][]): StockStatement {
  const warnings: string[] = [];
  const first = pages[0] ?? [];
  const all = first.map((i) => norm(i.str).toLowerCase());
  const source = all.includes("transit") ? "transit" : all.includes("physical stock") ? "physical" : null;
  if (!source || !all.includes("stock statement")) {
    throw new Error("This is not a CTDMS Stock Statement (Transit or Physical Stock).");
  }
  const dealerName = labelValue(first, /^dealer ?:$/i);
  const dealerCode = dealerName?.match(/\b([A-Z]{2}\d{2}[A-Z])$/)?.[1] ?? null;
  const date = labelValue(first, /^date:$/i)?.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  const totalVehicles = int(labelValue(first, /^total vehicles:$/i) ?? undefined);

  const rows: StockRow[] = [];
  pages.forEach((items, i) => rows.push(...parsePage(items, warnings, i + 1)));

  const seen = new Set<string>();
  const unique = rows.filter((r) => (seen.has(r.vin) ? false : (seen.add(r.vin), true)));
  if (unique.length !== rows.length) warnings.push(`${rows.length - unique.length} repeated VINs ignored`);
  if (totalVehicles !== null && unique.length !== totalVehicles) {
    warnings.push(`The report says ${totalVehicles} vehicles but ${unique.length} rows were read`);
  }
  const srs = unique.map((r) => r.sr).sort((a, b) => a - b);
  const gaps = srs.filter((s, i) => i > 0 && s !== srs[i - 1] + 1);
  if (gaps.length) warnings.push(`Rows missing before Sr. No. ${gaps.slice(0, 5).join(", ")}`);

  return {
    source,
    reportDate: date ? `${date[3]}-${date[2]}-${date[1]}` : null,
    dealerName: dealerName ? dealerName.replace(/\s+[A-Z]{2}\d{2}[A-Z]$/, "") : null,
    dealerCode,
    totalVehicles,
    rows: unique,
    warnings,
  };
}

// Browser only: extracts text items from every page with pdf.js, then parses them.
export async function readStockPdf(data: ArrayBuffer): Promise<StockStatement> {
  const pdfjs = await import("pdfjs-dist");
  const worker = new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), { type: "module" });
  pdfjs.GlobalWorkerOptions.workerPort = worker;
  const task = pdfjs.getDocument({ data: new Uint8Array(data) });
  const doc = await task.promise;
  try {
    if (doc.numPages > 60) throw new Error("This PDF has too many pages for a stock statement.");
    const pages: TextItem[][] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .filter((i): i is (typeof content.items)[number] & { str: string; transform: number[]; width: number } => "str" in i)
          .filter((i) => i.str.trim())
          .map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width })),
      );
    }
    return parseStockStatement(pages);
  } finally {
    await task.destroy();
    worker.terminate();
    pdfjs.GlobalWorkerOptions.workerPort = null;
  }
}
