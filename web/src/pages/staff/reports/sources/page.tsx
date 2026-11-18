import { createClient } from "@/lib/supabase/server";
import { Bars, Panel, PeriodBar } from "@/components/pipeline-ui";
import { loadBreakdowns, pct, resolvePeriod, type Breakdown } from "@/lib/pipeline";
import { cancelReasonLabel } from "../../cancellations/labels";

const byTotal = (a: Breakdown, b: Breakdown) => b.total - a.total || a.label.localeCompare(b.label);

// Where enquiries come from and how many book, why enquiries are lost and bookings cancelled, and
// which models are booked.
export default async function SourcesReportPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const period = resolvePeriod(params);
  const supabase = await createClient();
  const [{ data: outlets }, rows] = await Promise.all([
    supabase.from("outlets").select("id, name").eq("is_active", true).order("name"),
    loadBreakdowns(supabase, period.from, period.to, period.outletId),
  ]);
  const of = (kind: Breakdown["kind"]) => rows.filter((r) => r.kind === kind).sort(byTotal);
  const sources = of("source");
  const models = of("model");

  return (
    <div className="space-y-4">
      <PeriodBar outlets={outlets ?? []} period={period} />

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Enquiry sources">
          {sources.length === 0 ? (
            <p className="text-sm text-slate-400">No enquiries in this period.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-1 pr-3">Mode</th>
                  <th className="py-1 pr-3 text-right">Enquiries</th>
                  <th className="py-1 pr-3 text-right">Booked so far</th>
                  <th className="py-1 text-right">Conversion</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                {sources.map((r) => (
                  <tr key={r.label}>
                    <td className="py-1.5 pr-3">{r.label}</td>
                    <td className="py-1.5 pr-3 text-right">{r.total}</td>
                    <td className="py-1.5 pr-3 text-right">{r.converted}</td>
                    <td className="py-1.5 text-right">{pct(r.converted, r.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Bookings by model">
          {models.length === 0 ? (
            <p className="text-sm text-slate-400">No bookings in this period.</p>
          ) : (
            <Bars rows={models.map((r) => ({ label: r.label, value: r.total, note: r.converted ? `${r.converted} delivered` : undefined }))} />
          )}
        </Panel>

        <Panel title="Why enquiries were lost">
          {of("lost_reason").length === 0 ? (
            <p className="text-sm text-slate-400">No enquiries lost in this period.</p>
          ) : (
            <Bars rows={of("lost_reason").map((r) => ({ label: r.label, value: r.total }))} />
          )}
        </Panel>

        <Panel title="Why bookings were cancelled">
          {of("cancel_reason").length === 0 ? (
            <p className="text-sm text-slate-400">No cancellations approved in this period.</p>
          ) : (
            <Bars rows={of("cancel_reason").map((r) => ({ label: cancelReasonLabel(r.label), value: r.total }))} />
          )}
        </Panel>
      </div>
      <p className="text-xs text-slate-500">
        Sources count enquiries created in the period; &ldquo;booked so far&rdquo; is how many of those have booked by today.
      </p>
    </div>
  );
}
