import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { ReportFilterBar } from "@/components/report-filter-bar";
import {
  ASSIGN_MAX_RANK,
  CRM_SYNC_OPTIONS,
  MODE_OPTIONS,
  PURPOSE_OPTIONS,
  STAGE_OPTIONS,
  labelFor,
} from "@/lib/enquiries";
import { EnquiryRowActions } from "./enquiry-row-actions";

const STAGE_STYLES: Record<string, string> = {
  open: "bg-blue-100 text-blue-700",
  quoted: "bg-amber-100 text-amber-700",
  booked: "bg-emerald-100 text-emerald-700",
  lost: "bg-slate-200 text-slate-600",
};

const TEMPERATURE_STYLES: Record<string, string> = { HOT: "text-red-600", WRM: "text-amber-600", CLD: "text-sky-600" };

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

type Named = { name: string };
interface EnquiryListRow {
  id: string;
  created_at: string;
  stage: string;
  temperature: string;
  purpose_of_visit: string;
  mode: string;
  source_desc: string | null;
  test_drive_given: boolean;
  crm_sync_status: string;
  ctdms_enquiry_no: string | null;
  lost_reason: string | null;
  assigned_employee_id: string;
  customers: { name: string; mobile: string } | { name: string; mobile: string }[] | null;
  models: Named | Named[] | null;
  fuel_types: Named | Named[] | null;
  outlets: Named | Named[] | null;
  assigned: Named | Named[] | null;
}

export default async function EnquiriesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const employee = await getCurrentEmployee();
  const canAssign = employee?.roleRank != null && employee.roleRank <= ASSIGN_MAX_RANK;

  const [{ data: outlets }, { data: employees }] = await Promise.all([
    supabase.from("outlets").select("id, name").eq("is_active", true).order("name"),
    supabase.from("employees").select("id, name, roles(rank)").eq("is_active", true).order("name"),
  ]);

  // RLS limits rows to the caller's own enquiries, their team's, or their branch's/all for heads.
  let query = supabase
    .from("enquiries")
    .select(
      "id, created_at, stage, temperature, purpose_of_visit, mode, source_desc, test_drive_given, crm_sync_status, " +
        "ctdms_enquiry_no, lost_reason, assigned_employee_id, customers(name, mobile), models(name), fuel_types(name), " +
        "outlets(name), assigned:employees!enquiries_assigned_employee_id_fkey(name)",
    )
    .order("created_at", { ascending: false })
    .limit(300);

  if (params.outlet_id) query = query.eq("outlet_id", params.outlet_id);
  if (params.employee_id) query = query.eq("assigned_employee_id", params.employee_id);
  if (params.stage) query = query.eq("stage", params.stage);
  if (params.mode) query = query.eq("mode", params.mode);
  if (params.crm_sync_status) query = query.eq("crm_sync_status", params.crm_sync_status);
  if (params.from) query = query.gte("created_at", params.from);
  if (params.to) query = query.lte("created_at", `${params.to}T23:59:59`);

  const { data: enquiries, error } = await query;

  // Reassignment targets: consultants and team leaders at or below the caller's rank.
  const team = canAssign
    ? (employees ?? [])
        .filter((e) => {
          const role = one(e.roles);
          return role && role.rank >= (employee?.roleRank ?? 0);
        })
        .map((e) => ({ id: e.id, name: e.name }))
    : [];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Enquiries</h1>
          <p className="text-sm text-slate-500">Every walk-in, call and lead, from first contact to booking.</p>
        </div>
        <Link
          href="/enquiries/new"
          className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          New enquiry
        </Link>
      </div>

      <ReportFilterBar
        outlets={outlets ?? []}
        employees={(employees ?? []).map((e) => ({ id: e.id, name: e.name }))}
        values={params}
        extra={[
          { name: "stage", label: "Stage", options: STAGE_OPTIONS },
          { name: "mode", label: "Mode", options: MODE_OPTIONS },
          { name: "crm_sync_status", label: "Toyota CRM", options: CRM_SYNC_OPTIONS },
        ]}
      />

      {error && <p className="mb-3 text-sm text-red-600">{error.message}</p>}

      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              {["Date", "Customer", "Interest", "Source", "Consultant", "Stage", "Toyota CRM", ""].map((h) => (
                <th key={h} className="px-3 py-2 text-left font-medium text-slate-600">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(enquiries ?? []).map((row) => {
              const e = row as unknown as EnquiryListRow;
              const customer = one(e.customers);
              const model = one(e.models);
              const fuel = one(e.fuel_types);
              const outlet = one(e.outlets);
              const assigned = one(e.assigned);
              return (
                <tr key={e.id} className="align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                    {new Date(e.created_at).toLocaleDateString("en-IN")}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-900">{customer?.name}</div>
                    <div className="text-xs text-slate-500">{customer?.mobile}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div>
                      {model?.name}
                      {fuel ? ` · ${fuel.name}` : ""}
                    </div>
                    <div className="text-xs text-slate-500">
                      {labelFor(PURPOSE_OPTIONS, e.purpose_of_visit)}
                      {e.test_drive_given ? " · Test drive done" : ""}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div>{e.mode}</div>
                    {e.source_desc && <div className="text-xs text-slate-500">{e.source_desc}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <div>{assigned?.name ?? "—"}</div>
                    <div className="text-xs text-slate-500">{outlet?.name}</div>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STAGE_STYLES[e.stage] ?? ""}`}>
                      {labelFor(STAGE_OPTIONS, e.stage)}
                    </span>
                    <span className={`ml-2 text-xs font-medium ${TEMPERATURE_STYLES[e.temperature] ?? ""}`}>
                      {e.temperature}
                    </span>
                    {e.lost_reason && <div className="mt-1 text-xs text-slate-500">{e.lost_reason}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {e.ctdms_enquiry_no ?? labelFor(CRM_SYNC_OPTIONS, e.crm_sync_status)}
                  </td>
                  <td className="px-3 py-2">
                    {(e.stage === "open" || e.stage === "quoted") && (
                      <EnquiryRowActions enquiryId={e.id} assignedEmployeeId={e.assigned_employee_id} team={team} />
                    )}
                  </td>
                </tr>
              );
            })}
            {(!enquiries || enquiries.length === 0) && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-slate-400">
                  No enquiries match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
