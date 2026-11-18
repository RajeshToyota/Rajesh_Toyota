import { useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { parseCsv } from "@/lib/csv";
import { useRightGate } from "@/lib/rbac";
import { isMasterDataAdmin, useCurrentEmployee } from "@/lib/auth";
import { ActionForm, Card, Chip, EmptyRow, ErrorBox, Loaded, PageHeader, RunButton, Table, Td, fmtDate, inputCls, inr, num, rpc } from "@/ui";
import { useVariants, variantLabel } from "./shared";

type Rule = { variant_id: string; coupon_cap: number | null; mr_discount: number | null; mr_approved_at: string | null; employees: { name: string } | null };

// Techwheels' Variant Coupon Cap: the most a consultant may give as a coupon on each variant, and an
// MR discount the Business Head has approved in advance. The margin floor applies on top.
export default function DiscountRules() {
  const me = useCurrentEmployee();
  const canEdit = useRightGate("discount_rules", "edit") || isMasterDataAdmin(me);
  const variants = useVariants();
  const defaults = useQuery(async () => must(await supabase.from("pricing_config").select("key, value").in("key", ["coupon_cap_default", "margin_buffer"])) as { key: string; value: number }[], []);
  const rules = useQuery(
    async () => must(await supabase.from("discount_rules_variant").select("variant_id, coupon_cap, mr_discount, mr_approved_at, employees(name)")) as unknown as Rule[],
    [],
  );
  const [filter, setFilter] = useState("");
  const [csv, setCsv] = useState<string[][] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const byId = useMemo(() => new Map((rules.data ?? []).map((r) => [r.variant_id, r])), [rules.data]);
  const def = (k: string) => defaults.data?.find((d) => d.key === k)?.value;

  const csvRows = useMemo(() => {
    if (!csv || csv.length < 2) return [];
    const head = csv[0].map((h) => h.trim().toLowerCase());
    const bySuffix = new Map((variants.data ?? []).map((v) => [String(v.tkm_suffix_code ?? "").toUpperCase(), v.id]));
    return csv
      .slice(1)
      .filter((r) => r.some((c) => c.trim()))
      .map((r) => {
        const get = (k: string) => (r[head.indexOf(k)] ?? "").trim();
        return { suffix: get("suffix"), variant_id: bySuffix.get(get("suffix").toUpperCase()), coupon_cap: get("coupon_cap"), mr_discount: get("mr_discount") };
      });
  }, [csv, variants.data]);

  return (
    <div>
      <PageHeader
        title="Variant Coupon Cap"
        note={
          <>
            Without a rule the cap is {inr(def("coupon_cap_default"))}. Margin floor: dealer discount + coupon + MR may not exceed (ex-showroom − dealer cost) + TKM share − schemes −{" "}
            {inr(def("margin_buffer"))}; a quote below it goes to the Business Head.
          </>
        }
      />
      {canEdit && (
        <Card title="Import from CSV" note="Columns: suffix (TKM suffix code), coupon_cap, mr_discount. An MR discount is approved by whoever imports it, which must be the Business Head.">
          <div className="space-y-2 px-3 py-2">
            <input type="file" accept=".csv" className="text-xs" onChange={(e) => e.target.files?.[0]?.text().then((t) => setCsv(parseCsv(t)))} />
            {error && <ErrorBox message={error} />}
            {csvRows.length > 0 && (
              <>
                <p className="text-sm text-slate-600">
                  {csvRows.filter((r) => r.variant_id).length} rows match a variant, {csvRows.filter((r) => !r.variant_id).length} do not:{" "}
                  {csvRows.filter((r) => !r.variant_id).map((r) => r.suffix).join(", ")}
                </p>
                <RunButton
                  label="Import"
                  run={async () => {
                    setError(null);
                    try {
                      await rpc("upsert_discount_rules", { p_rows: csvRows.filter((r) => r.variant_id) });
                      setCsv(null);
                      rules.reload();
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    }
                  }}
                />
              </>
            )}
          </div>
        </Card>
      )}
      <Card aside={<input className={inputCls} placeholder="Search variant" value={filter} onChange={(e) => setFilter(e.target.value)} />}>
        <Loaded q={variants}>
          {(list) => {
            const shown = list.filter((v) => !filter || variantLabel(v).toLowerCase().includes(filter.toLowerCase()));
            return (
              <Table head={["Variant", "Coupon cap", "MR discount", "Approved", ""]}>
                {shown.length === 0 ? (
                  <EmptyRow cols={5} text="No variants." />
                ) : (
                  shown.map((v) => {
                    const r = byId.get(v.id);
                    return (
                      <tr key={v.id}>
                        <Td>{variantLabel(v)}</Td>
                        <Td right>{r?.coupon_cap != null ? inr(r.coupon_cap) : <span className="text-slate-400">{inr(def("coupon_cap_default"))} (default)</span>}</Td>
                        <Td right>{r?.mr_discount ? inr(r.mr_discount) : "—"}</Td>
                        <Td muted>{r?.mr_approved_at ? `${r.employees?.name ?? ""} · ${fmtDate(r.mr_approved_at)}` : r?.mr_discount ? <Chip tone="amber">Not approved</Chip> : ""}</Td>
                        <Td>
                          {canEdit && (
                            <ActionForm
                              tone="light"
                              label="Save"
                              hidden={{}}
                              fields={[
                                { name: "cap", placeholder: "Coupon cap", type: "number", width: "w-28", initial: r?.coupon_cap != null ? String(r.coupon_cap) : "" },
                                { name: "mr", placeholder: "MR discount", type: "number", width: "w-28", initial: r?.mr_discount ? String(r.mr_discount) : "" },
                              ]}
                              action={async (fd) => {
                                await rpc("upsert_discount_rules", { p_rows: [{ variant_id: v.id, coupon_cap: num(fd, "cap"), mr_discount: num(fd, "mr") }] });
                                rules.reload();
                              }}
                            />
                          )}
                        </Td>
                      </tr>
                    );
                  })
                )}
              </Table>
            );
          }}
        </Loaded>
      </Card>
    </div>
  );
}
