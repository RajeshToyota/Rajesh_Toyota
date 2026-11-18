import { useState } from "react";
import { useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, Stat, Table, Tabs, Td, fmtDate, inputCls, inr, rpc, rpcRows, str, todayIst } from "@/ui";

type Car = {
  id: string;
  outlet: string;
  reg_no: string;
  car: string;
  mfg_year: number | null;
  odometer_km: number | null;
  status: string;
  procurement_price: number;
  refurbishment_cost: number;
  listed_price: number | null;
  sold_price: number | null;
  margin: number | null;
  procured_on: string;
  sold_on: string | null;
  days_in_stock: number;
  buyer_name: string | null;
  utrust: boolean;
  from_customer: string;
};
type Summary = { outlet: string; requested: number; evaluated: number; procured: number; conversion_pct: number | null; avg_gap_pct: number | null; sold: number; sales_value: number | null; margin: number | null; in_stock: number; stock_value: number | null };

// Techwheels' used-car stock: cars bought in on exchange, refurbished, listed and sold.
export default function Stock() {
  const [status, setStatus] = useState("in_stock_all");
  const q = useQuery(() => rpcRows<Car>("used_car_stock_list", { p_status: status === "all" ? null : status }), [status]);
  const canEdit = useRightGate("used_car_stock", "edit");
  return (
    <div>
      <PageHeader title="Used Car Stock" note="Margin = sold − bought − refurbishment." />
      <Tabs current={status} onChange={setStatus} tabs={[{ id: "in_stock_all", label: "In stock" }, { id: "sold", label: "Sold" }, { id: "all", label: "All" }]} />
      <Card>
        <Loaded q={q}>
          {(rows) => (
            <Table head={["Car", "Bought", "Refurb.", "Listed / sold", "Days", "Status", canEdit ? "Update" : ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={7} text="No cars." />
              ) : (
                rows.map((c) => (
                  <tr key={c.id}>
                    <Td>
                      <span className="font-mono text-xs">{c.reg_no}</span> {c.utrust && <Chip tone="emerald">U Trust</Chip>}
                      <div>{c.car}</div>
                      <div className="text-xs text-slate-500">
                        {[c.mfg_year, c.odometer_km != null && `${c.odometer_km.toLocaleString("en-IN")} km`, `from ${c.from_customer}`, c.outlet].filter(Boolean).join(" · ")}
                      </div>
                    </Td>
                    <Td right>
                      {inr(c.procurement_price)}
                      <div className="text-xs text-slate-500">{fmtDate(c.procured_on)}</div>
                    </Td>
                    <Td right>{inr(c.refurbishment_cost)}</Td>
                    <Td right>
                      {c.sold_price != null ? (
                        <>
                          {inr(c.sold_price)}
                          <div className={`text-xs ${Number(c.margin) >= 0 ? "text-emerald-700" : "text-red-700"}`}>margin {inr(c.margin)}</div>
                        </>
                      ) : (
                        inr(c.listed_price)
                      )}
                    </Td>
                    <Td right>{c.days_in_stock}</Td>
                    <Td>
                      <Chip tone={c.status === "sold" ? "emerald" : c.status === "listed" ? "blue" : "amber"}>{c.status.replace("_", " ")}</Chip>
                      {c.buyer_name && <div className="text-xs text-slate-500">{c.buyer_name}</div>}
                    </Td>
                    <Td>
                      {canEdit && !["sold", "returned"].includes(c.status) && (
                        <div className="flex flex-col gap-1">
                          <ActionForm
                            tone="light"
                            label="Refurb."
                            hidden={{}}
                            fields={[{ name: "cost", placeholder: "Add ₹", type: "number", required: true, width: "w-24" }]}
                            action={async (fd) => {
                              await rpc("update_used_car", { p_id: c.id, p: { status: "refurbishing", add_refurbishment: Number(str(fd, "cost")) } });
                            }}
                          />
                          <ActionForm
                            tone="light"
                            label="List"
                            hidden={{}}
                            fields={[{ name: "price", placeholder: "Price ₹", type: "number", required: true, width: "w-24" }]}
                            action={async (fd) => {
                              await rpc("update_used_car", { p_id: c.id, p: { status: "listed", listed_price: Number(str(fd, "price")) } });
                            }}
                          />
                          <ActionForm
                            label="Sold"
                            hidden={{}}
                            fields={[
                              { name: "price", placeholder: "Sold ₹", type: "number", required: true, width: "w-24" },
                              { name: "buyer", placeholder: "Buyer", required: true, width: "w-28" },
                              { name: "mobile", placeholder: "Mobile", width: "w-24" },
                            ]}
                            action={async (fd) => {
                              await rpc("update_used_car", { p_id: c.id, p: { status: "sold", sold_price: Number(str(fd, "price")), buyer_name: str(fd, "buyer"), buyer_mobile: str(fd, "mobile") } });
                            }}
                          />
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
    </div>
  );
}

export function UsedCarSummary() {
  const today = todayIst();
  const [from, setFrom] = useState(today.slice(0, 8) + "01");
  const [to, setTo] = useState(today);
  const q = useQuery(() => rpcRows<Summary>("used_car_summary", { p_from: from, p_to: to }), [from, to]);
  return (
    <div>
      <PageHeader
        title="Exchange Summary"
        note="Evaluations, how many became purchases, how far customers' asks were from our valuation, and used-car sales."
        actions={
          <>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
          </>
        }
      />
      <Loaded q={q}>
        {(rows) => (
          <>
            <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
              <Stat label="Evaluated" value={rows.reduce((a, r) => a + r.evaluated, 0)} />
              <Stat label="Bought in" value={rows.reduce((a, r) => a + r.procured, 0)} />
              <Stat label="Sold" value={rows.reduce((a, r) => a + r.sold, 0)} note={inr(rows.reduce((a, r) => a + Number(r.sales_value ?? 0), 0))} />
              <Stat label="Margin" value={inr(rows.reduce((a, r) => a + Number(r.margin ?? 0), 0))} />
            </div>
            <Card>
              <Table head={["Branch", "Requested", "Evaluated", "Bought", "Conversion", "Ask over value", "Sold", "Margin", "In stock"]}>
                {rows.map((r) => (
                  <tr key={r.outlet}>
                    <Td>{r.outlet}</Td>
                    <Td right>{r.requested}</Td>
                    <Td right>{r.evaluated}</Td>
                    <Td right>{r.procured}</Td>
                    <Td right>{r.conversion_pct != null ? `${r.conversion_pct}%` : "—"}</Td>
                    <Td right>{r.avg_gap_pct != null ? `${r.avg_gap_pct}%` : "—"}</Td>
                    <Td right>{r.sold}</Td>
                    <Td right>{inr(r.margin)}</Td>
                    <Td right>
                      {r.in_stock}
                      <div className="text-xs text-slate-500">{inr(r.stock_value)}</div>
                    </Td>
                  </tr>
                ))}
              </Table>
            </Card>
          </>
        )}
      </Loaded>
    </div>
  );
}
