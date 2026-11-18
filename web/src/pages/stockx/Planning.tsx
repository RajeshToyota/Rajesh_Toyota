import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, RunButton, Table, Tabs, Td, fmtDate, rpcRows } from "@/ui";
import { OutletPicker } from "@/pages/ops/shared";

type Plan = {
  variant_id: string;
  color_id: string;
  model: string;
  variant: string;
  suffix: string | null;
  color: string;
  sales_m1: number;
  sales_m2: number;
  sales_m3: number;
  weighted_sales: number;
  vna: number;
  free: number;
  open_orders: number;
  need: number;
  order_qty: number;
  excess: number;
  status: string;
};
type OpenOrder = { id: string; quantity: number; order_ref: string | null; ordered_on: string; expected_on: string | null; variants: { name: string } | null; colors: { name: string } | null; outlets: { name: string } | null };

// Techwheels' projected stock planning, per variant and colour.
export default function Planning() {
  const [outlet, setOutlet] = useState("");
  const [tab, setTab] = useState("plan");
  const q = useQuery(() => rpcRows<Plan>("stock_planning", { p_outlet_id: outlet || null }), [outlet]);
  return (
    <div>
      <PageHeader
        title="Stock Planning"
        note="Monthly sales = 0.5 × the last 30 days + 0.3 × the 30 before + 0.2 × the 30 before that. Need = the larger of sales and customers waiting (VNA). Order = need − (free + on order)."
        actions={<OutletPicker value={outlet} onChange={setOutlet} />}
      />
      <Tabs current={tab} onChange={setTab} tabs={[{ id: "plan", label: "Plan" }, { id: "excess", label: "Excess orders" }, { id: "orders", label: "Open orders" }]} />
      {tab === "orders" ? (
        <OpenOrders outlet={outlet} plans={q.data ?? []} />
      ) : (
        <Card>
          <Loaded q={q}>
            {(rows) => {
              const shown = tab === "excess" ? rows.filter((r) => r.excess > 0) : rows;
              return (
                <Table head={["Car", "Sales (30/60/90)", "Weighted", "VNA", "Free", "On order", tab === "excess" ? "Excess" : "Order", "Status"]}>
                  {shown.length === 0 ? (
                    <EmptyRow cols={8} text="Nothing to show." />
                  ) : (
                    shown.map((r) => (
                      <tr key={`${r.variant_id}-${r.color_id}`}>
                        <Td>
                          {r.model} {r.variant}
                          <div className="text-xs text-slate-500">
                            {r.suffix} · {r.color}
                          </div>
                        </Td>
                        <Td muted>
                          {r.sales_m1} / {r.sales_m2} / {r.sales_m3}
                        </Td>
                        <Td right>{r.weighted_sales}</Td>
                        <Td right>{r.vna}</Td>
                        <Td right>{r.free}</Td>
                        <Td right>{r.open_orders}</Td>
                        <Td right className="font-semibold">
                          {tab === "excess" ? r.excess : r.order_qty || ""}
                        </Td>
                        <Td>
                          <Chip tone={r.status === "ORDER NOW" ? "red" : r.status === "MONITOR" ? "amber" : "emerald"}>{r.status}</Chip>
                        </Td>
                      </tr>
                    ))
                  )}
                </Table>
              );
            }}
          </Loaded>
        </Card>
      )}
    </div>
  );
}

function OpenOrders({ outlet, plans }: { outlet: string; plans: Plan[] }) {
  const canEdit = useRightGate("stock_planning", "edit");
  const outlets = useQuery(async () => must(await supabase.from("outlets").select("id, name").eq("is_active", true).order("name")) as { id: string; name: string }[], []);
  const variants = useQuery(async () => must(await supabase.from("variants").select("id, name, tkm_suffix_code").eq("is_active", true).order("name")) as { id: string; name: string; tkm_suffix_code: string | null }[], []);
  const colors = useQuery(async () => must(await supabase.from("colors").select("id, name").order("name")) as { id: string; name: string }[], []);
  const q = useQuery(async () => {
    let query = supabase.from("open_orders").select("id, quantity, order_ref, ordered_on, expected_on, variants(name), colors(name), outlets(name)").eq("status", "open");
    if (outlet) query = query.eq("outlet_id", outlet);
    return must(await query.order("ordered_on", { ascending: false })) as unknown as OpenOrder[];
  }, [outlet]);
  void plans;
  return (
    <>
      {canEdit && (
        <Card title="Add an order placed with TKM">
          <div className="px-3 py-2">
            <ActionForm
              label="Add"
              hidden={{}}
              fields={[
                { name: "outlet", placeholder: "Branch", options: outlets.data ?? [], required: true, width: "w-36", initial: outlet },
                { name: "variant", placeholder: "Variant", options: (variants.data ?? []).map((v) => ({ id: v.id, name: `${v.name} ${v.tkm_suffix_code ?? ""}` })), required: true, width: "w-48" },
                { name: "color", placeholder: "Colour", options: colors.data ?? [], required: true, width: "w-36" },
                { name: "qty", placeholder: "Qty", type: "number", required: true, width: "w-16" },
                { name: "ref", placeholder: "Order ref", width: "w-28" },
                { name: "eta", placeholder: "Expected", type: "date", width: "w-36" },
              ]}
              action={async (fd) => {
                must(
                  await supabase.from("open_orders").insert({
                    outlet_id: fd.get("outlet"),
                    variant_id: fd.get("variant"),
                    color_id: fd.get("color"),
                    quantity: Number(fd.get("qty")),
                    order_ref: fd.get("ref") || null,
                    expected_on: fd.get("eta") || null,
                  }),
                );
                q.reload();
              }}
            />
          </div>
        </Card>
      )}
      <Card>
        <Loaded q={q}>
          {(rows) => (
            <Table head={["Branch", "Car", "Qty", "Ordered", "Expected", ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={6} text="No open orders." />
              ) : (
                rows.map((o) => (
                  <tr key={o.id}>
                    <Td muted>{o.outlets?.name}</Td>
                    <Td>
                      {o.variants?.name} · {o.colors?.name}
                      {o.order_ref && <div className="text-xs text-slate-500">{o.order_ref}</div>}
                    </Td>
                    <Td right>{o.quantity}</Td>
                    <Td muted>{fmtDate(o.ordered_on)}</Td>
                    <Td muted>{fmtDate(o.expected_on)}</Td>
                    <Td>
                      {canEdit && (
                        <div className="flex gap-1">
                          <RunButton tone="light" label="Received" run={async () => { must(await supabase.from("open_orders").update({ status: "received" }).eq("id", o.id)); q.reload(); }} />
                          <RunButton tone="danger" label="Cancel" run={async () => { must(await supabase.from("open_orders").update({ status: "cancelled" }).eq("id", o.id)); q.reload(); }} />
                        </div>
                      )}
                    </Td>
                  </tr>
                ))
              )}
            </Table>
          )}
        </Loaded>
      </Card>
    </>
  );
}
