// Lost to competition: which customers who once enquired with us registered a vehicle bought from
// another dealer (another Toyota dealer, or another brand), found by matching the RTO registration
// dump to the enquiry list on mobile number. Pure functions; the page (pages/crm/LostSales) reads the
// files and shows the result. Everything runs in the browser: the dumps are never uploaded.

import { parseCsv } from "@/lib/csv";
import { readXls } from "@/lib/xls";
import { excelDate, readXlsx } from "@/lib/xlsx";

export type Grid = string[][];

// Reads .xlsx, .xls or .csv into a grid of strings.
export async function readSheet(file: File): Promise<Grid> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv") || name.endsWith(".txt")) return parseCsv(new TextDecoder().decode(buf));
  if (buf[0] === 0x50 && buf[1] === 0x4b) return readXlsx(buf);
  if (buf[0] === 0xd0 && buf[1] === 0xcf) return readXls(buf);
  return parseCsv(new TextDecoder().decode(buf));
}

// Header text to a comparison key: letters only, lower case ("Reg. Date " → "regdate").
const headerKey = (h: string) => (h ?? "").toLowerCase().replace(/[^a-z]/g, "");

// Each RTO month comes with its own column names and order; these are the names seen so far.
const RTO_COLUMNS = {
  office: ["officename", "office", "rtooffice"],
  regNo: ["regnumber", "vehiclenumber", "registrationnumber", "vehnumber", "regnno", "regno", "registrationno", "vehicleno"],
  regDate: ["regdate", "registrationdate", "regndate"],
  vehicleClass: ["vehicleclass", "class"],
  owner: ["ownername", "owner", "name"],
  mobile: ["ownermobilenumber", "mobilenumber", "mobile", "mobileno", "ownermobile", "contactno", "phone"],
  address: ["currentaddress", "currentadd", "address"],
  financer: ["financername", "financer"],
  maker: ["makername", "maker", "manufacturer", "make"],
  model: ["modelname", "model"],
  purchaseDate: ["purchaseddate", "purchasedate"],
  amount: ["saleamount", "amount"],
  dealer: ["dealername", "dealer"],
} as const;

const ENQUIRY_COLUMNS = {
  name: ["customername", "name", "customer"],
  mobile: ["mobilenumber", "mobile", "mobileno", "contactno", "phone", "customermobile"],
  model: ["modelname", "model"],
  grade: ["gradecode", "grade", "variant"],
  officer: ["salesofficer", "salesconsultant", "consultant", "so", "dse", "executive"],
  date: ["enquirydate", "date", "createddate", "createdon"],
} as const;

type Cols<T> = { [K in keyof T]: number | null };

function findHeader<T extends Record<string, readonly string[]>>(grid: Grid, spec: T, required: (keyof T)[]) {
  // The header is the first of the top rows that names every required column.
  for (let r = 0; r < Math.min(grid.length, 15); r++) {
    const keys = (grid[r] ?? []).map(headerKey);
    const cols = {} as Cols<T>;
    for (const k of Object.keys(spec) as (keyof T)[]) {
      const i = spec[k].map((a) => keys.indexOf(a)).find((i) => i >= 0);
      cols[k] = i ?? null;
    }
    if (required.every((k) => cols[k] !== null)) return { row: r, cols };
  }
  return null;
}

export function normMobile(v: string | null | undefined): string | null {
  let d = String(v ?? "").replace(/\D/g, "");
  if (d.length > 10 && (d.startsWith("91") || d.startsWith("0"))) d = d.slice(-10);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

export type RtoRow = {
  file: string;
  office: string;
  regNo: string;
  regDate: string;
  vehicleClass: string;
  owner: string;
  mobile: string | null;
  address: string;
  financer: string;
  maker: string;
  brand: string;
  model: string;
  purchaseDate: string;
  amount: number | null;
  dealer: string;
  isCar: boolean;
  isToyota: boolean;
};

export function parseRto(grid: Grid, file: string): RtoRow[] {
  const h = findHeader(grid, RTO_COLUMNS, ["mobile", "maker", "dealer"]);
  if (!h) throw new Error(`${file}: no header row with Mobile Number, Maker and Dealer Name columns.`);
  const c = h.cols;
  const at = (row: string[], i: number | null) => (i === null ? "" : (row[i] ?? "").trim());
  const out: RtoRow[] = [];
  for (const row of grid.slice(h.row + 1)) {
    if (!row || row.every((v) => !v)) continue;
    const maker = at(row, c.maker);
    const amount = Number(at(row, c.amount).replace(/[^\d.]/g, ""));
    const brand = brandOf(maker);
    const vehicleClass = at(row, c.vehicleClass);
    out.push({
      file,
      office: at(row, c.office),
      regNo: at(row, c.regNo),
      regDate: excelDate(at(row, c.regDate)),
      vehicleClass,
      owner: at(row, c.owner),
      mobile: normMobile(at(row, c.mobile)),
      address: at(row, c.address),
      financer: at(row, c.financer),
      maker,
      brand,
      model: at(row, c.model),
      purchaseDate: excelDate(at(row, c.purchaseDate)),
      amount: amount > 0 ? amount : null,
      dealer: at(row, c.dealer).replace(/\s+/g, " "),
      isCar: brand !== "Tractor" && !NOT_A_CAR.test(vehicleClass) && !/TRACTOR/i.test(maker),
      isToyota: brand === "Toyota" || brand === "Lexus",
    });
  }
  return out;
}

export type EnquiryRow = { source: string; name: string; mobile: string; model: string; grade: string; officer: string; date: string };

export function parseEnquiries(grid: Grid, file: string): { rows: EnquiryRow[]; badMobiles: number } {
  const h = findHeader(grid, ENQUIRY_COLUMNS, ["mobile"]);
  if (!h) throw new Error(`${file}: no header row with a Mobile Number column.`);
  const c = h.cols;
  const at = (row: string[], i: number | null) => (i === null ? "" : (row[i] ?? "").trim().replace(/\s+/g, " "));
  const rows: EnquiryRow[] = [];
  let badMobiles = 0;
  for (const row of grid.slice(h.row + 1)) {
    if (!row || row.every((v) => !v)) continue;
    const mobile = normMobile(at(row, c.mobile));
    if (!mobile) {
      badMobiles++;
      continue;
    }
    rows.push({ source: file, name: at(row, c.name), mobile, model: at(row, c.model), grade: at(row, c.grade), officer: at(row, c.officer), date: excelDate(at(row, c.date)) });
  }
  return { rows, badMobiles };
}

// One brand name per manufacturer, whatever spelling the RTO used ("MAHINDRA  MAHINDRA LIMITED",
// "MAHINDRA & MAHINDRA LIMITED (TRACTOR)", …).
const BRANDS: [RegExp, string][] = [
  [/TOYOTA/, "Toyota"],
  [/MARUTI/, "Maruti Suzuki"],
  [/HYUNDAI/, "Hyundai"],
  [/TATA/, "Tata"],
  [/MAHINDRA/, "Mahindra"],
  [/\bKIA\b/, "Kia"],
  [/HONDA/, "Honda"],
  [/SKODA|VOLKSWAGEN/, "Skoda / VW"],
  [/\bMG\b|MG MOTOR/, "MG"],
  [/RENAULT/, "Renault"],
  [/NISSAN/, "Nissan"],
  [/CITROEN|STELLANTIS|\bJEEP\b|FCA/, "Citroen / Jeep"],
  [/MERCEDES/, "Mercedes-Benz"],
  [/\bBMW\b/, "BMW"],
  [/AUDI/, "Audi"],
  [/JAGUAR|LAND ROVER/, "JLR"],
  [/VOLVO/, "Volvo"],
  [/\bBYD\b/, "BYD"],
  [/VINFAST/, "VinFast"],
  [/FORCE MOTORS/, "Force"],
  [/ISUZU/, "Isuzu"],
  [/LEXUS/, "Lexus"],
  [/TAFE|ESCORTS|SONALIKA|INTERNATIONAL TRACTORS|JOHN DEERE|NEW HOLLAND|SWARAJ|KUBOTA|CNH/, "Tractor"],
];
export function brandOf(maker: string) {
  const m = maker.toUpperCase();
  return BRANDS.find(([re]) => re.test(m))?.[1] ?? (maker.trim() || "Unknown");
}

const NOT_A_CAR = /TRACTOR|BUS|AMBULANCE|HARVESTER|TRAILER|GOODS|TRUCK|LOADER/i;

// Our own Toyota dealership names as the RTO prints them: Toyota dealer names that mention RAJESH.
export const guessOwnDealers = (toyotaDealers: [string, number][]) => toyotaDealers.map(([d]) => d).filter((d) => /RAJESH/i.test(d)).sort();

export type Outcome = "ours" | "other_toyota" | "other_brand";
export const OUTCOME_LABEL: Record<Outcome, string> = { ours: "Bought from us", other_toyota: "Other Toyota dealer", other_brand: "Other brand" };

// An RTO registration whose mobile is in an enquiry, with how many registrations carry that mobile.
export type Candidate = RtoRow & { mobileRegs: number };

// What the report works from (the database's lost_sales_data, or datasetFromRows for files in hand).
export type Dataset = {
  totals: { rows: number; noMobile: number; notCar: number };
  enquiryMobiles: number;
  // Enquiries per sales officer, over all enquiries (not only those that registered).
  officerEnquiries: [string, number][];
  toyotaDealers: [string, number][];
  candidates: Candidate[];
  enquiries: EnquiryRow[];
};

export function datasetFromRows(rto: RtoRow[], enquiries: EnquiryRow[]): Dataset {
  const enqMobiles = new Set(enquiries.map((e) => e.mobile));
  const perMobile = new Map<string, number>();
  for (const r of rto) if (r.mobile) perMobile.set(r.mobile, (perMobile.get(r.mobile) ?? 0) + 1);
  const candidates = rto.filter((r) => r.mobile && enqMobiles.has(r.mobile)).map((r) => ({ ...r, mobileRegs: perMobile.get(r.mobile!) ?? 1 }));
  const candMobiles = new Set(candidates.map((c) => c.mobile));
  return {
    totals: { rows: rto.length, noMobile: rto.filter((r) => !r.mobile).length, notCar: rto.filter((r) => r.mobile && !r.isCar).length },
    enquiryMobiles: enqMobiles.size,
    officerEnquiries: tally(enquiries, (e) => e.officer),
    toyotaDealers: tally(rto.filter((r) => r.isToyota), (r) => r.dealer),
    candidates,
    enquiries: enquiries.filter((e) => candMobiles.has(e.mobile)),
  };
}

export type Match = RtoRow & { mobile: string; outcome: Outcome; enquiries: EnquiryRow[] };

export type Options = {
  ownDealers: Set<string>;
  // A mobile number on more registrations than this is a dealer's or agent's, not the customer's.
  bulkLimit: number;
  carsOnly: boolean;
};

export function matchRto(ds: Dataset, opt: Options) {
  const byMobile = new Map<string, EnquiryRow[]>();
  for (const e of ds.enquiries) {
    const list = byMobile.get(e.mobile);
    if (list) list.push(e);
    else byMobile.set(e.mobile, [e]);
  }
  const matches: Match[] = [];
  let skippedBulk = 0;
  for (const r of ds.candidates) {
    if (!r.mobile || (opt.carsOnly && !r.isCar)) continue;
    const enq = byMobile.get(r.mobile);
    if (!enq) continue;
    if (r.mobileRegs > opt.bulkLimit) {
      skippedBulk++;
      continue;
    }
    const outcome: Outcome = r.isToyota ? (opt.ownDealers.has(r.dealer) ? "ours" : "other_toyota") : "other_brand";
    matches.push({ ...r, mobile: r.mobile, outcome, enquiries: enq });
  }
  const skippedNotCar = opt.carsOnly ? ds.totals.notCar : 0;
  return {
    matches,
    considered: ds.totals.rows - ds.totals.noMobile - skippedNotCar,
    skippedBulk,
    skippedNotCar,
    noMobile: ds.totals.noMobile,
    enquiryMobiles: ds.enquiryMobiles,
    officerEnquiries: ds.officerEnquiries,
  };
}

// Count by key, largest first.
export function tally<T>(rows: T[], key: (r: T) => string) {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r) || "—";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m].sort((a, b) => b[1] - a[1]);
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function matchesCsv(rows: Match[]) {
  const head = [
    "Outcome", "Customer (RTO)", "Mobile", "Reg No", "Reg Date", "Purchase Date", "RTO Office", "Brand", "Maker", "Model bought",
    "Sale Amount", "Dealer", "Financer", "Enquiry name", "Enquired model", "Grade", "Sales officer", "Enquiry count", "Address",
  ];
  const lines = rows.map((r) =>
    [
      OUTCOME_LABEL[r.outcome], r.owner, r.mobile, r.regNo, r.regDate, r.purchaseDate, r.office, r.brand, r.maker, r.model,
      r.amount ?? "", r.dealer, r.financer,
      uniq(r.enquiries.map((e) => e.name)), uniq(r.enquiries.map((e) => e.model)), uniq(r.enquiries.map((e) => e.grade)),
      uniq(r.enquiries.map((e) => e.officer)), r.enquiries.length, r.address,
    ].map(csvCell).join(","),
  );
  return [head.join(","), ...lines].join("\n");
}

export const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].join(" / ");
