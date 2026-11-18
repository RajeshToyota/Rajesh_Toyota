import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { Bars, Panel, PeriodBar, StatTile } from "@/components/pipeline-ui";
import {
  ACTIVITY_KEYS,
  SNAPSHOT_KEYS,
  inr,
  loadActivity,
  loadAgeing,
  loadSnapshot,
  pct,
  resolvePeriod,
  sumBy,
  todayIst,
} from "@/lib/pipeline";

// The pipeline at a glance: what happened in the period, what is open now, branch by branch, and
// what needs someone's attention. Everything is limited to what the viewer may see.
export default async function DashboardHome({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const period = resolvePeriod(params);
  const supabase = await createClient();
  const viewer = await getCurrentEmployee();
  // The CTDMS reports are uploaded by the back office (Outlet Head to Head Customer Relations and above).
  const backOffice = viewer?.roleRank != null && viewer.roleRank <= 3;
  const today = todayIst();
  const outletId = period.outletId;

  // Narrows a count query to the chosen branch when there is one.
  const scope: Record<string, string> = outletId ? { outlet_id: outletId } : {};
  const head = { count: "exact" as const, head: true };

  const [
    { data: outlets },
    activity,
    snapshot,
    ageing,
    enquiriesToEnter,
    enquiryMismatches,
    bookingsToEnter,
    lastEnquiryReport,
    outstanding,
    chequesPending,
    refundsOverdue,
    financeOpen,
  ] = await Promise.all([
    supabase.from("outlets").select("id, name").eq("is_active", true).order("name"),
    loadActivity(supabase, period.from, period.to, outletId),
    loadSnapshot(supabase, outletId),
    loadAgeing(supabase, outletId),
    supabase.from("enquiries").select("id", head).eq("crm_sync_status", "pending_entry").neq("stage", "lost").match(scope),
    supabase.from("enquiries").select("id", head).eq("crm_sync_status", "mismatch").neq("stage", "lost").match(scope),
    supabase.from("bookings").select("id", head).in("crm_sync_status", ["pending_entry", "mismatch"]).neq("status", "cancelled").match(scope),
    supabase.from("crm_import_batches").select("created_at").eq("kind", "enquiry_report").order("created_at", { ascending: false }).limit(1),
    supabase.rpc("outstanding_bookings"),
    supabase.from("payment_receipts").select("id", head).eq("clearance_status", "pending").match(scope),
    supabase.from("refunds").select("id", head).eq("status", "pending").lt("due_date", today).match(scope),
    supabase.from("finance_cases").select("id", head).not("status", "in", "(disbursed,rejected)").match(scope),
  ]);

  const outletName = new Map((outlets ?? []).map((o) => [o.id, o.name]));
  const total = sumBy(activity, ACTIVITY_KEYS).get(null) ?? Object.fromEntries(ACTIVITY_KEYS.map((k) => [k, 0]));
  const open = sumBy(snapshot, SNAPSHOT_KEYS).get(null) ?? Object.fromEntries(SNAPSHOT_KEYS.map((k) => [k, 0]));
  const byOutletActivity = sumBy(activity, ACTIVITY_KEYS, (r) => r.outlet_id);
  const byOutletOpen = sumBy(snapshot, SNAPSHOT_KEYS, (r) => r.outlet_id);
  const branchIds = [...new Set([...byOutletActivity.keys(), ...byOutletOpen.keys()])].filter((k): k is string => !!k);
  branchIds.sort((a, b) => (outletName.get(a) ?? "").localeCompare(outletName.get(b) ?? ""));

  const outstandingRows = ((outstanding.data ?? []) as { outlet: string; outstanding: number }[]).filter(
    (r) => Number(r.outstanding) > 0 && (!outletId || r.outlet === outletName.get(outletId)),
  );
  const outstandingSum = outstandingRows.reduce((s, r) => s + Number(r.outstanding), 0);
  const old = ageing.filter((a) => a.age_band === "90+");
  const oldCars = old.reduce((s, a) => s + a.cars, 0);
  const stockInterest = ageing.reduce((s, a) => s + Number(a.interest), 0);
  const lastUpload = lastEnquiryReport.data?.[0]?.created_at as string | undefined;
  const openBookings = open.awaiting_car + open.allotted + open.with_accounts + open.billed_not_delivered + open.on_hold + open.cancel_requested;
  const qs = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();

  const attention = [
    { show: (enquiriesToEnter.count ?? 0) > 0, text: `${enquiriesToEnter.count} enquiries still to enter in Toyota CRM`, href: "/crm-sync" },
    { show: (enquiryMismatches.count ?? 0) > 0, text: `${enquiryMismatches.count} enquiries marked done but missing in CTDMS`, href: "/crm-sync" },
    { show: (bookingsToEnter.count ?? 0) > 0, text: `${bookingsToEnter.count} bookings still to book in CTDMS`, href: "/crm-sync" },
    {
      show: backOffice && (!lastUpload || new Date(Date.parse(lastUpload) + 5.5 * 3_600_000).toISOString().slice(0, 10) < today),
      text: lastUpload
        ? `Today's CTDMS enquiry report is not uploaded yet (last: ${new Date(lastUpload).toLocaleDateString("en-IN")})`
        : "No CTDMS enquiry report uploaded yet",
      href: "/crm-sync",
    },
    { show: outstandingRows.length > 0, text: `${outstandingRows.length} allotted cars with ${inr(outstandingSum)} still to collect`, href: "/payments" },
    { show: (chequesPending.count ?? 0) > 0, text: `${chequesPending.count} cheques / DDs waiting for clearance`, href: "/payments" },
    { show: (refundsOverdue.count ?? 0) > 0, text: `${refundsOverdue.count} refunds past their 7-working-day due date`, href: "/cancellations" },
    { show: oldCars > 0, text: `${oldCars} cars in stock for more than 90 days`, href: "/reports/stock-ageing" },
    { show: (financeOpen.count ?? 0) > 0, text: `${financeOpen.count} finance cases in progress`, href: "/finance" },
    { show: open.cancel_requested > 0, text: `${open.cancel_requested} cancellations waiting for the Outlet Head`, href: "/cancellations" },
    { show: open.quotes_awaiting_approval > 0, text: `${open.quotes_awaiting_approval} quotes waiting for approval`, href: "/reports/approvals" },
  ].filter((a) => a.show);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Pipeline</h1>
        <p className="text-sm text-slate-500">Enquiry to delivery. Numbers cover only the people and branches you can see.</p>
      </div>
      <PeriodBar outlets={outlets ?? []} period={period} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        <StatTile label="Enquiries" value={total.enquiries} note={`${total.test_drives} test drives`} />
        <StatTile label="Bookings" value={total.bookings} note={`${pct(total.bookings, total.enquiries)} of enquiries`} />
        <StatTile label="Billed" value={total.billed} />
        <StatTile label="Delivered" value={total.delivered} />
        <StatTile label="Cancelled" value={total.cancelled} />
        <StatTile label="Enquiries lost" value={total.lost} href={`/reports/sources${qs ? `?${qs}` : ""}`} />
        <StatTile label="Open bookings" value={openBookings} note="right now" />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="This period, step by step">
          <Bars
            rows={[
              { label: "Enquiries", value: total.enquiries },
              { label: "Quotes made", value: total.quotes },
              { label: "Quotes finalised", value: total.final_quotes },
              { label: "Bookings", value: total.bookings },
              { label: "Cars allotted", value: total.allotted },
              { label: "Billed", value: total.billed },
              { label: "Delivered", value: total.delivered },
            ]}
          />
          <p className="mt-3 text-xs text-slate-500">
            Each step counts what happened in the period, so a booking this month may come from last month&apos;s enquiry.
          </p>
        </Panel>

        <Panel title="Open right now">
          <Bars
            rows={[
              { label: "Enquiries open", value: open.open_enquiries, href: "/enquiries" },
              { label: "Enquiries quoted", value: open.quoted_enquiries, href: "/enquiries" },
              { label: "Quotes for approval", value: open.quotes_awaiting_approval, href: "/reports/approvals" },
              { label: "Bookings awaiting a car", value: open.awaiting_car, href: "/stock/match" },
              { label: "Car allotted", value: open.allotted, href: "/stock/allotted" },
              { label: "With Accounts to bill", value: open.with_accounts, href: "/stock/billing" },
              { label: "Billed, not delivered", value: open.billed_not_delivered, href: "/reports/bookings" },
              { label: "On hold", value: open.on_hold, href: "/cancellations" },
              { label: "Cancellation asked", value: open.cancel_requested, href: "/cancellations" },
            ]}
          />
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <Panel
            title="By branch"
            aside={
              <Link href={`/reports/consultants${qs ? `?${qs}` : ""}`} className="text-xs text-slate-600 underline">
                By consultant →
              </Link>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th className="py-1 pr-3">Branch</th>
                    <th className="py-1 pr-3 text-right">Enquiries</th>
                    <th className="py-1 pr-3 text-right">Bookings</th>
                    <th className="py-1 pr-3 text-right">Conversion</th>
                    <th className="py-1 pr-3 text-right">Billed</th>
                    <th className="py-1 pr-3 text-right">Delivered</th>
                    <th className="py-1 pr-3 text-right">Cancelled</th>
                    <th className="py-1 text-right">Open bookings</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 tabular-nums">
                  {branchIds.length === 0 && (
                    <tr>
                      <td colSpan={8} className="py-4 text-center text-slate-400">
                        Nothing in this period.
                      </td>
                    </tr>
                  )}
                  {branchIds.map((id) => {
                    const a = byOutletActivity.get(id);
                    const s = byOutletOpen.get(id);
                    const openB = s ? s.awaiting_car + s.allotted + s.with_accounts + s.billed_not_delivered + s.on_hold + s.cancel_requested : 0;
                    return (
                      <tr key={id}>
                        <td className="py-1.5 pr-3">{outletName.get(id) ?? "Other branch"}</td>
                        <td className="py-1.5 pr-3 text-right">{a?.enquiries ?? 0}</td>
                        <td className="py-1.5 pr-3 text-right">{a?.bookings ?? 0}</td>
                        <td className="py-1.5 pr-3 text-right">{pct(a?.bookings ?? 0, a?.enquiries ?? 0)}</td>
                        <td className="py-1.5 pr-3 text-right">{a?.billed ?? 0}</td>
                        <td className="py-1.5 pr-3 text-right">{a?.delivered ?? 0}</td>
                        <td className="py-1.5 pr-3 text-right">{a?.cancelled ?? 0}</td>
                        <td className="py-1.5 text-right">{openB}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>

        <Panel title="Needs attention">
          {attention.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing waiting.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {attention.map((a) => (
                <li key={a.text}>
                  <Link href={a.href} className="text-slate-800 underline decoration-slate-300 hover:decoration-slate-600">
                    {a.text}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {stockInterest > 0 && (
            <p className="mt-3 text-xs text-slate-500">Interest on unbilled stock so far: {inr(stockInterest)}.</p>
          )}
        </Panel>
      </div>
    </div>
  );
}
