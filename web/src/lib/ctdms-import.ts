// Recognises the two CTDMS exports the back office uploads daily and maps their columns to the
// row shape the import RPCs take (20261026000001_ctdms_sync.sql). Input is the sheet as a grid of
// strings, from readXls() or parseCsv(); CTDMS puts title and filter rows above the header row.

export type CtdmsRow = Record<string, string>;

export type CtdmsReport =
  | { kind: "enquiry_report"; from: string | null; to: string | null; dealerCodes: string[]; rows: CtdmsRow[] }
  | { kind: "order_listing"; dealerCode: string; statusFilter: string | null; rows: CtdmsRow[] };

export class CtdmsFormatError extends Error {}

const ENQUIRY_COLUMNS: Record<string, string> = {
  "ENQUIRY NUMBER": "enquiry_no",
  "ENQUIRY DT": "enquiry_date",
  "DEALER CODE": "dealer_code",
  "CUSTOMER NAME": "customer_name",
  "MOBILE NUMBER": "mobile",
  "MODEL NAME": "model_name",
  "GRADE CODE": "grade",
  "MODEL SUFFIX CODE": "suffix_code",
  "EXTERIOR COLOR CODE": "color_code",
  "ENQIRY STATUS": "status", // sic: CTDMS's own spelling
  "ENQUIRY STATUS": "status",
  ENQUIRY_MODE_NAME: "mode",
  ENQUIRY_SOURCE_DESC: "source_desc",
  "TEST DRIVE GIVEN STATUS": "test_drive",
  SALES_OFFICER: "sales_officer",
};

const ORDER_COLUMNS: Record<string, string> = {
  "DEALER CODE": "dealer_code",
  "ORDER NO": "order_no",
  "ORDER DATE": "order_date",
  "ORDER STATUS": "order_status",
  MODEL: "model",
  "SUFFIX CODE": "suffix_code",
  "EXTERIOR COLOR CODE": "color_code",
  "VIN NUMBER": "vin",
  "CUSTOMER CODE": "customer_code",
  "CUSTOMER NAME": "customer_name",
  "INSTITUTIONAL GROUP TYPE": "institutional_group_type",
  "ORGANIZATION NAME": "organization_name",
  "TEAM LEADER": "team_leader",
  "SALES OFFICER": "sales_officer",
  "RECEIVED AMOUNT": "received_amount",
  ICROP_ENQUIRY_NBR: "icrop_enquiry_no",
  "ORDER ID": "order_id",
};

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const key = (s: string | undefined) => clean(s).toUpperCase();

function mapRows(grid: string[][], headerIndex: number, columns: Record<string, string>, keyField: string) {
  const header = grid[headerIndex].map(key);
  const positions = header.map((h) => columns[h] ?? null);
  const rows: CtdmsRow[] = [];
  for (const line of grid.slice(headerIndex + 1)) {
    const row: CtdmsRow = {};
    positions.forEach((field, i) => {
      if (field && clean(line[i])) row[field] = clean(line[i]);
    });
    if (row[keyField]) rows.push(row);
  }
  return rows;
}

// Value in the cell after a label such as "FROM DATE" or "Dealer :" in the title rows.
function labelled(grid: string[][], upTo: number, label: RegExp): string | null {
  for (const line of grid.slice(0, upTo)) {
    const i = line.findIndex((c) => label.test(clean(c)));
    if (i >= 0) {
      const v = line.slice(i + 1).map(clean).find(Boolean);
      if (v) return v;
    }
  }
  return null;
}

// DD/MM/YYYY (CTDMS text) or YYYY-MM-DD (date-formatted cell) -> YYYY-MM-DD.
export function toIsoDate(s: string | null): string | null {
  if (!s) return null;
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

export function detectCtdmsReport(grid: string[][]): CtdmsReport {
  const scan = Math.min(grid.length, 40);
  for (let i = 0; i < scan; i++) {
    const cells = grid[i].map(key);
    if (cells.includes("ENQUIRY NUMBER") && cells.includes("MOBILE NUMBER")) {
      const rows = mapRows(grid, i, ENQUIRY_COLUMNS, "enquiry_no");
      if (rows.length === 0) throw new CtdmsFormatError("The enquiry report has no enquiries.");
      return {
        kind: "enquiry_report",
        from: toIsoDate(labelled(grid, i, /^FROM DATE$/i)),
        to: toIsoDate(labelled(grid, i, /^TO DATE$/i)),
        dealerCodes: [...new Set(rows.map((r) => r.dealer_code).filter(Boolean))].sort(),
        rows,
      };
    }
    if (cells.includes("ORDER NO") && cells.includes("ORDER STATUS")) {
      const rows = mapRows(grid, i, ORDER_COLUMNS, "order_no");
      const codes = [...new Set(rows.map((r) => r.dealer_code).filter(Boolean))];
      if (codes.length > 1) {
        throw new CtdmsFormatError(`This listing mixes branches (${codes.join(", ")}). Export one branch per file.`);
      }
      // A branch with no open orders still names itself in the "Dealer :" title row.
      const dealerCode = codes[0] ?? labelled(grid, i, /^Dealer\s*:$/i)?.split(" ").pop() ?? null;
      if (!dealerCode) throw new CtdmsFormatError("Could not tell which branch this order listing is for.");
      if (rows.length === 0) throw new CtdmsFormatError("The order listing has no orders.");
      return { kind: "order_listing", dealerCode, statusFilter: labelled(grid, i, /^Order Status\s*:$/i), rows };
    }
  }
  throw new CtdmsFormatError(
    "Not a CTDMS Enquiry Survey Report or PO Order Listing. Upload the export as it comes from CTDMS (.xls) or saved as CSV.",
  );
}
