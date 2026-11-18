import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { CRM_BACK_OFFICE_MAX_RANK, CRM_SYNC_OPTIONS, PURPOSE_OPTIONS, labelFor } from "@/lib/enquiries";
import { BookingDone, CreateFromCtdms, EnquiryDone } from "./queue-actions";
import { ImportSummary, UploadPanel } from "./upload-panel";

const TABS = [
  { id: "enter", label: "To enter in Toyota CRM" },
  { id: "book", label: "To book in CTDMS" },
  { id: "missing", label: "Missing in our CRM" },
  { id: "history", label: "Upload history" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("en-IN") : "—");
const SYNC_STYLES: Record<string, string> = {
  pending_entry: "bg-amber-100 text-amber-800",
  mismatch: "bg-red-100 text-red-700",
};

type Named = { name: string };

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-3 py-2 text-left font-medium text-slate-600">{children}</th>;
}
function Empty({ cols, text }: { cols: number; text: string }) {
  return (
    <tr>
      <td colSpan={cols} className="px-3 py-6 text-center text-slate-400">
        {text}
      </td>
    </tr>
  );
}
function SyncChip({ status }: { status: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${SYNC_STYLES[status] ?? "bg-slate-100 text-slate-600"}`}>
      {labelFor(CRM_SYNC_OPTIONS, status)}
    </span>
  );
}

export default async function CrmSyncPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const tab: Tab = TABS.some((t) => t.id === params.tab) ? (params.tab as Tab) : "enter";
  const supabase = await createClient();
  const employee = await getCurrentEmployee();

  if (employee?.roleRank == null || employee.roleRank > CRM_BACK_OFFICE_MAX_RANK) {
    return (
      <p className="text-sm text-slate-600">
        CTDMS sync is for the back office (Head Customer Relations, Outlet Head and above).
      </p>
    );
  }

  const enquiryQueue = () =>
    supabase.from("enquiries").select("id", { count: "exact", head: true })
      .in("crm_sync_status", ["pending_entry", "mismatch"]).neq("stage", "lost");
  const bookingQueue = () =>
    supabase.from("bookings").select("id", { count: "exact", head: true })
      .eq("imported_from_ctdms", false).in("crm_sync_status", ["pending_entry", "mismatch"]).neq("status", "cancelled");
  const [{ count: enterCount }, { count: bookCount }, { count: awaitingCount }] = await Promise.all([
    enquiryQueue(),
    bookingQueue(),
    supabase.from("enquiries").select("id", { count: "exact", head: true }).eq("crm_sync_status", "marked_done"),
  ]);

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-slate-900">CTDMS Sync</h1>
        <p className="text-sm text-slate-500">
          Keep Toyota&apos;s CRM and ours in step: upload the day&apos;s CTDMS exports, then clear the queues.
          {awaitingCount ? ` ${awaitingCount} enquiries are marked entered and wait for the next report to confirm.` : ""}
        </p>
      </div>

      <UploadPanel />

      <div className="mb-3 flex gap-1 border-b border-slate-200">
        {TABS.map((t) => {
          const count = t.id === "enter" ? enterCount : t.id === "book" ? bookCount : null;
          return (
            <Link
              key={t.id}
              href={`/crm-sync?tab=${t.id}`}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                tab === t.id ? "border-slate-900 font-medium text-slate-900" : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              {t.label}
              {count ? <span className="ml-1 rounded-full bg-slate-200 px-1.5 text-xs">{count}</span> : null}
            </Link>
          );
        })}
      </div>

      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        {tab === "enter" && <EnterQueue />}
        {tab === "book" && <BookQueue />}
        {tab === "missing" && <MissingQueue />}
        {tab === "history" && <History />}
      </div>
    </div>
  );
}

// Enquiries in our CRM that CTDMS doesn't have yet (or that the last report didn't contain).
async function EnterQueue() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("enquiries")
    .select(
      "id, created_at, purpose_of_visit, mode, source_desc, test_drive_given, temperature, crm_sync_status, " +
        "customers(name, mobile), models(name), fuel_types(name), variants(tkm_suffix_code), colors(tkm_color_code), " +
        "outlets(name), assigned:employees!enquiries_assigned_employee_id_fkey(name, ctdms_name)",
    )
    .in("crm_sync_status", ["pending_entry", "mismatch"])
    .neq("stage", "lost")
    .order("created_at")
    .limit(500);

  type Row = {
    id: string; created_at: string; purpose_of_visit: string; mode: string; source_desc: string | null;
    test_drive_given: boolean; temperature: string; crm_sync_status: string;
    customers: { name: string; mobile: string } | null; models: Named | null; fuel_types: Named | null;
    variants: { tkm_suffix_code: string | null } | null; colors: { tkm_color_code: string | null } | null;
    outlets: Named | null; assigned: { name: string; ctdms_name: string | null } | null;
  };
  const rows = (data ?? []) as unknown as Row[];

  return (
    <table className="min-w-full divide-y divide-slate-200 text-sm">
      <thead className="bg-slate-50">
        <tr>
          <Th>Date</Th><Th>Customer</Th><Th>Model</Th><Th>Mode / source</Th><Th>Consultant</Th><Th>Status</Th><Th />
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {error && <Empty cols={7} text={error.message} />}
        {rows.map((e) => {
          const customer = one(e.customers);
          const assigned = one(e.assigned);
          const suffix = one(e.variants)?.tkm_suffix_code;
          const color = one(e.colors)?.tkm_color_code;
          return (
            <tr key={e.id} className="align-top">
              <td className="whitespace-nowrap px-3 py-2 text-slate-600">{fmtDate(e.created_at)}</td>
              <td className="px-3 py-2">
                <div className="font-medium text-slate-900">{customer?.name}</div>
                <div className="text-xs text-slate-500">{customer?.mobile}</div>
              </td>
              <td className="px-3 py-2">
                <div>{one(e.models)?.name}{one(e.fuel_types) ? ` · ${one(e.fuel_types)?.name}` : ""}</div>
                <div className="text-xs text-slate-500">
                  {[suffix, color].filter(Boolean).join(" / ") || labelFor(PURPOSE_OPTIONS, e.purpose_of_visit)}
                  {` · ${e.temperature}`}{e.test_drive_given ? " · Test drive" : ""}
                </div>
              </td>
              <td className="px-3 py-2">
                <div>{e.mode}</div>
                {e.source_desc && <div className="text-xs text-slate-500">{e.source_desc}</div>}
              </td>
              <td className="px-3 py-2">
                <div>{assigned?.ctdms_name ?? assigned?.name ?? "—"}</div>
                <div className="text-xs text-slate-500">{one(e.outlets)?.name}</div>
              </td>
              <td className="px-3 py-2"><SyncChip status={e.crm_sync_status} /></td>
              <td className="px-3 py-2"><EnquiryDone enquiryId={e.id} /></td>
            </tr>
          );
        })}
        {!error && rows.length === 0 && <Empty cols={7} text="Every enquiry is in CTDMS." />}
      </tbody>
    </table>
  );
}

// Bookings made in our CRM that have no CTDMS order yet, or whose order the last listing lacked.
async function BookQueue() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("bookings")
    .select(
      "id, created_at, order_booking_no, ctdms_order_booking_no, customer_name, payment_amount, crm_sync_status, " +
        "variants(name, tkm_suffix_code), colors(name, tkm_color_code), outlets(name), " +
        "employees!bookings_employee_id_fkey(name, ctdms_name)",
    )
    .eq("imported_from_ctdms", false)
    .in("crm_sync_status", ["pending_entry", "mismatch"])
    .neq("status", "cancelled")
    .order("created_at")
    .limit(500);

  type Row = {
    id: string; created_at: string; order_booking_no: string | null; ctdms_order_booking_no: string | null;
    customer_name: string | null; payment_amount: number | null; crm_sync_status: string;
    variants: { name: string; tkm_suffix_code: string | null } | null;
    colors: { name: string; tkm_color_code: string | null } | null; outlets: Named | null;
    employees: { name: string; ctdms_name: string | null } | null;
  };
  const rows = (data ?? []) as unknown as Row[];

  return (
    <table className="min-w-full divide-y divide-slate-200 text-sm">
      <thead className="bg-slate-50">
        <tr>
          <Th>Booked</Th><Th>Customer</Th><Th>Vehicle</Th><Th>Booking amount</Th><Th>Consultant</Th><Th>Status</Th><Th>CTDMS order no.</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {error && <Empty cols={7} text={error.message} />}
        {rows.map((b) => {
          const variant = one(b.variants);
          const color = one(b.colors);
          const emp = one(b.employees);
          return (
            <tr key={b.id} className="align-top">
              <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                {fmtDate(b.created_at)}
                {b.order_booking_no && <div className="text-xs text-slate-500">{b.order_booking_no}</div>}
              </td>
              <td className="px-3 py-2 font-medium text-slate-900">{b.customer_name ?? "—"}</td>
              <td className="px-3 py-2">
                <div>{variant?.name}</div>
                <div className="text-xs text-slate-500">
                  {[variant?.tkm_suffix_code, color?.tkm_color_code].filter(Boolean).join(" / ")}
                  {color ? ` · ${color.name}` : ""}
                </div>
              </td>
              <td className="px-3 py-2">{b.payment_amount != null ? `₹${Number(b.payment_amount).toLocaleString("en-IN")}` : "—"}</td>
              <td className="px-3 py-2">
                <div>{emp?.ctdms_name ?? emp?.name ?? "—"}</div>
                <div className="text-xs text-slate-500">{one(b.outlets)?.name}</div>
              </td>
              <td className="px-3 py-2">
                <SyncChip status={b.crm_sync_status} />
                {b.crm_sync_status === "mismatch" && b.ctdms_order_booking_no && (
                  <div className="mt-1 text-xs text-red-700">{b.ctdms_order_booking_no} not in the open list</div>
                )}
              </td>
              <td className="px-3 py-2"><BookingDone bookingId={b.id} /></td>
            </tr>
          );
        })}
        {!error && rows.length === 0 && <Empty cols={7} text="Every booking has its CTDMS order." />}
      </tbody>
    </table>
  );
}

// CTDMS enquiries we have no record of, newest upload first, one line per enquiry number.
async function MissingQueue() {
  const supabase = await createClient();
  const [{ data: batches }, { data: staff }, { data: models }, { data: variants }] = await Promise.all([
    supabase.from("crm_import_batches").select("id").eq("kind", "enquiry_report").order("created_at", { ascending: false }).limit(30),
    supabase.from("employees").select("id, name, ctdms_name").eq("is_active", true).order("name"),
    supabase.from("models").select("id, name, tkm_model_code").eq("is_active", true).order("name"),
    supabase.from("variants").select("model_id, tkm_suffix_code").not("tkm_suffix_code", "is", null),
  ]);
  const batchOrder = (batches ?? []).map((b) => b.id);
  const { data, error } = batchOrder.length
    ? await supabase
        .from("crm_import_rows")
        .select("id, batch_id, ctdms_no, dealer_code, mobile, data")
        .eq("match_status", "missing_in_crm")
        .in("batch_id", batchOrder)
        .order("row_no")
        .limit(5000)
    : { data: [], error: null };

  type Row = { id: string; batch_id: string; ctdms_no: string; dealer_code: string | null; mobile: string | null; data: Record<string, string> };
  const all = ((data ?? []) as unknown as Row[]).sort((a, b) => batchOrder.indexOf(a.batch_id) - batchOrder.indexOf(b.batch_id));
  const seen = new Set<string>();
  const latest = all.filter((r) => !seen.has(r.ctdms_no) && seen.add(r.ctdms_no));
  // Rows from older uploads whose enquiry has since been created or matched.
  const { data: linked } = latest.length
    ? await supabase.from("enquiries").select("ctdms_enquiry_no").in("ctdms_enquiry_no", latest.map((r) => r.ctdms_no))
    : { data: [] };
  const linkedNos = new Set((linked ?? []).map((e) => e.ctdms_enquiry_no));
  const rows = latest.filter((r) => !linkedNos.has(r.ctdms_no));

  // Same resolution as create_enquiry_from_ctdms, to know which rows need a choice.
  const staffByCtdms = new Set((staff ?? []).map((s) => s.ctdms_name?.toUpperCase()).filter(Boolean));
  const suffixes = new Set((variants ?? []).map((v) => v.tkm_suffix_code));
  const prefixes = new Set((models ?? []).map((m) => m.tkm_model_code).filter(Boolean));
  const modelResolves = (d: Record<string, string>) => {
    const suffix = (d.suffix_code ?? "").toUpperCase();
    if (suffixes.has(suffix) || (suffix && prefixes.has(suffix.slice(0, 3)))) return true;
    const name = (d.model_name ?? "").toUpperCase().replace(/^\s*TOYOTA\s+/, "").trim();
    if (!name) return false;
    const names = (models ?? []).map((m) => m.name.toUpperCase());
    return names.includes(name) || names.filter((n) => n.startsWith(name)).length === 1;
  };
  const employeeOptions = (staff ?? []).map((s) => ({ id: s.id, name: s.name }));
  const modelOptions = (models ?? []).map((m) => ({ id: m.id, name: m.name }));

  return (
    <table className="min-w-full divide-y divide-slate-200 text-sm">
      <thead className="bg-slate-50">
        <tr>
          <Th>CTDMS enquiry</Th><Th>Customer</Th><Th>Model</Th><Th>Mode / source</Th><Th>Sales Officer</Th><Th>CTDMS status</Th><Th />
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {error && <Empty cols={7} text={error.message} />}
        {rows.map((r) => {
          const d = r.data;
          const so = (d.sales_officer ?? "").toUpperCase();
          return (
            <tr key={r.id} className="align-top">
              <td className="px-3 py-2">
                <div className="font-medium text-slate-900">{r.ctdms_no}</div>
                <div className="text-xs text-slate-500">{d.enquiry_date} · {r.dealer_code}</div>
              </td>
              <td className="px-3 py-2">
                <div>{d.customer_name}</div>
                <div className="text-xs text-slate-500">{r.mobile ?? `${d.mobile ?? "no mobile"} (invalid)`}</div>
              </td>
              <td className="px-3 py-2">
                <div>{d.model_name}</div>
                <div className="text-xs text-slate-500">{[d.suffix_code, d.color_code].filter(Boolean).join(" / ")}</div>
              </td>
              <td className="px-3 py-2">
                <div>{d.mode}</div>
                {d.source_desc && <div className="text-xs text-slate-500">{d.source_desc}</div>}
              </td>
              <td className="px-3 py-2">{d.sales_officer ?? "—"}</td>
              <td className="px-3 py-2">{d.status}{d.test_drive === "YES" ? " · TD" : ""}</td>
              <td className="px-3 py-2">
                {r.mobile ? (
                  <CreateFromCtdms
                    rowId={r.id}
                    needsEmployee={!staffByCtdms.has(so)}
                    needsModel={!modelResolves(d)}
                    employees={employeeOptions}
                    models={modelOptions}
                  />
                ) : (
                  <span className="text-xs text-slate-500">Fix the mobile in CTDMS first</span>
                )}
              </td>
            </tr>
          );
        })}
        {!error && rows.length === 0 && <Empty cols={7} text="Nothing in CTDMS is missing from our CRM." />}
      </tbody>
    </table>
  );
}

async function History() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("crm_import_batches")
    .select("id, kind, file_name, dealer_codes, report_from, report_to, summary, created_at, employees(name)")
    .order("created_at", { ascending: false })
    .limit(60);

  type Row = {
    id: string; kind: string; file_name: string | null; dealer_codes: string[]; report_from: string | null;
    report_to: string | null; summary: Record<string, unknown>; created_at: string; employees: Named | null;
  };
  const rows = (data ?? []) as unknown as Row[];

  return (
    <table className="min-w-full divide-y divide-slate-200 text-sm">
      <thead className="bg-slate-50">
        <tr>
          <Th>Uploaded</Th><Th>Report</Th><Th>Result</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {error && <Empty cols={3} text={error.message} />}
        {rows.map((b) => (
          <tr key={b.id} className="align-top">
            <td className="whitespace-nowrap px-3 py-2 text-slate-600">
              {new Date(b.created_at).toLocaleString("en-IN")}
              <div className="text-xs text-slate-500">{one(b.employees)?.name}</div>
            </td>
            <td className="px-3 py-2">
              <div>{b.kind === "enquiry_report" ? "Enquiry Survey Report" : "PO Order Listing"} · {b.dealer_codes.join(", ")}</div>
              <div className="text-xs text-slate-500">
                {b.file_name}
                {b.report_from ? ` · ${fmtDate(b.report_from)} to ${fmtDate(b.report_to)}` : ""}
              </div>
            </td>
            <td className="px-3 py-2"><ImportSummary summary={b.summary} /></td>
          </tr>
        ))}
        {!error && rows.length === 0 && <Empty cols={3} text="No uploads yet." />}
      </tbody>
    </table>
  );
}
