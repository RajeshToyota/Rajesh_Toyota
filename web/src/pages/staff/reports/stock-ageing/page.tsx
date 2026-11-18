import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Panel } from "@/components/pipeline-ui";
import { inr, loadAgeing, type Ageing } from "@/lib/pipeline";

const BANDS: Ageing["age_band"][] = ["0-30", "31-60", "61-90", "90+", "unknown"];
const BAND_LABEL: Record<Ageing["age_band"], string> = {
  "0-30": "0–30 days",
  "31-60": "31–60",
  "61-90": "61–90",
  "90+": "Over 90",
  unknown: "No invoice date",
};

function Count({ c }: { c: { cars: number; free: number } }) {
  return c.cars ? (
    <>
      {c.cars}
      <span className="ml-1 text-xs text-slate-500">({c.free} free)</span>
    </>
  ) : (
    <span className="text-slate-300">0</span>
  );
}

// Cars not yet billed, by branch and age since the TKM invoice, with the interest they are costing.
// Free cars (not allotted) are the ones to push first.
export default async function StockAgeingPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const supabase = await createClient();
  const source = params.source === "transit" || params.source === "physical" ? params.source : null;
  const [{ data: outlets }, all] = await Promise.all([
    supabase.from("outlets").select("id, name").order("name"),
    loadAgeing(supabase, null),
  ]);
  const rows = source ? all.filter((r) => r.source === source) : all;
  const outletName = new Map((outlets ?? []).map((o) => [o.id, o.name]));
  const branchIds = [...new Set(rows.map((r) => r.outlet_id))].sort((a, b) =>
    (outletName.get(a) ?? "").localeCompare(outletName.get(b) ?? ""),
  );
  const cell = (outlet: string | null, band: Ageing["age_band"] | null) =>
    rows
      .filter((r) => (!outlet || r.outlet_id === outlet) && (!band || r.age_band === band))
      .reduce((t, r) => ({ cars: t.cars + r.cars, free: t.free + r.free_cars, interest: t.interest + Number(r.interest) }), {
        cars: 0,
        free: 0,
        interest: 0,
      });
  const usedBands = BANDS.filter((b) => b !== "unknown" || rows.some((r) => r.age_band === "unknown"));
  const grand = cell(null, null);

  return (
    <div className="space-y-4">
      <form className="flex flex-wrap items-end gap-3 rounded-md border border-slate-200 bg-white p-3">
        <label className="text-xs font-medium text-slate-500">
          Stock
          <select name="source" defaultValue={source ?? ""} className="mt-1 block rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900">
            <option value="">Transit and physical</option>
            <option value="physical">Physical only</option>
            <option value="transit">In transit only</option>
          </select>
        </label>
        <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800">
          Show
        </button>
      </form>

      <Panel
        title={`Unbilled stock: ${grand.cars} cars, ${grand.free} free`}
        aside={
          <Link href="/stock" className="text-xs text-slate-600 underline">
            Free stock list →
          </Link>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="py-1 pr-3">Branch</th>
                {usedBands.map((b) => (
                  <th key={b} className="py-1 pr-3 text-right">
                    {BAND_LABEL[b]}
                  </th>
                ))}
                <th className="py-1 pr-3 text-right">Total</th>
                <th className="py-1 text-right">Interest so far</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 tabular-nums">
              {branchIds.length === 0 && (
                <tr>
                  <td colSpan={usedBands.length + 3} className="py-4 text-center text-slate-400">
                    No unbilled stock you can see. Upload the CTDMS stock statements under Stock.
                  </td>
                </tr>
              )}
              {branchIds.map((id) => (
                <tr key={id}>
                  <td className="py-1.5 pr-3">{outletName.get(id) ?? "Other branch"}</td>
                  {usedBands.map((b) => (
                    <td key={b} className={`py-1.5 pr-3 text-right ${b === "90+" && cell(id, b).free ? "font-semibold text-red-700" : ""}`}>
                      <Count c={cell(id, b)} />
                    </td>
                  ))}
                  <td className="py-1.5 pr-3 text-right">
                    <Count c={cell(id, null)} />
                  </td>
                  <td className="py-1.5 text-right">{inr(cell(id, null).interest)}</td>
                </tr>
              ))}
            </tbody>
            {branchIds.length > 1 && (
              <tfoot className="border-t border-slate-200 font-medium tabular-nums">
                <tr>
                  <td className="py-2 pr-3">Total</td>
                  {usedBands.map((b) => (
                    <td key={b} className="py-2 pr-3 text-right">
                      <Count c={cell(null, b)} />
                    </td>
                  ))}
                  <td className="py-2 pr-3 text-right">
                    <Count c={grand} />
                  </td>
                  <td className="py-2 text-right">{inr(grand.interest)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Age counts from the TKM invoice date to today. Interest is as of the last stock statement uploaded. Free cars over 90 days
          are in red.
        </p>
      </Panel>
    </div>
  );
}
