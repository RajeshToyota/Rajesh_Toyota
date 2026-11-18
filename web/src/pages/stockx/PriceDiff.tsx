import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, Table, Tabs, Td, fmtDate, inr, rpc, rpcRows, str } from "@/ui";

type Row = {
  booking_id: string;
  customer_name: string;
  order_no: string | null;
  outlet: string;
  consultant: string | null;
  model: string | null;
  variant: string | null;
  color: string | null;
  priced_on: string;
  booked_price: number;
  current_price: number;
  difference: number;
  resolved: number | null;
  last_resolution: string | null;
  in_pool: boolean;
};

// Techwheels' SAP price difference: a booking priced before a price rise waits in the pool until the
// difference is collected (Accounts) or waived (Outlet Head).
export default function PriceDiff() {
  const [open, setOpen] = useState("open");
  const q = useQuery(() => rpcRows<Row>("price_diff_list", { p_open_only: open === "open" }), [open]);
  const canCollect = useRightGate("price_diff", "edit");
  const canWaive = useRightGate("price_diff", "approve");
  return (
    <div>
      <PageHeader title="Price Difference" note="Ex-showroom on the day the booking was priced vs today. While open, the booking cannot win a car in the allotment pool." />
      <Tabs current={open} onChange={setOpen} tabs={[{ id: "open", label: "Open" }, { id: "all", label: "All with a difference" }]} />
      <Card>
        <Loaded q={q}>
          {(rows) => (
            <Table head={["Customer", "Car", "Priced on", "Then", "Now", "Difference", ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={7} text="No price differences." />
              ) : (
                rows.map((r) => {
                  const settled = Number(r.resolved ?? 0) >= Number(r.difference);
                  return (
                    <tr key={r.booking_id}>
                      <Td>
                        <Link to={`/reports/bookings/${r.booking_id}`} className="font-medium hover:underline">
                          {r.customer_name}
                        </Link>
                        <div className="text-xs text-slate-500">{[r.order_no, r.consultant, r.outlet].filter(Boolean).join(" · ")}</div>
                      </Td>
                      <Td>
                        {[r.model, r.variant, r.color].filter(Boolean).join(" · ")} {r.in_pool && <Chip tone="blue">In pool</Chip>}
                      </Td>
                      <Td muted>{fmtDate(r.priced_on)}</Td>
                      <Td right>{inr(r.booked_price)}</Td>
                      <Td right>{inr(r.current_price)}</Td>
                      <Td right>
                        <span className="font-medium text-amber-700">{inr(r.difference)}</span>
                        {r.last_resolution && <div className="text-xs text-slate-500">{r.last_resolution}</div>}
                      </Td>
                      <Td>
                        {!settled && (
                          <div className="flex flex-col gap-1">
                            {canCollect && (
                              <ActionForm
                                label="Collected"
                                hidden={{}}
                                fields={[{ name: "note", placeholder: "Receipt no.", width: "w-28" }]}
                                action={async (fd) => {
                                  await rpc("resolve_price_difference", { p_booking_id: r.booking_id, p_resolution: "collected", p_note: str(fd, "note") });
                                }}
                              />
                            )}
                            {canWaive && (
                              <ActionForm
                                tone="light"
                                label="Waive"
                                hidden={{}}
                                fields={[{ name: "note", placeholder: "Why", required: true, width: "w-28" }]}
                                action={async (fd) => {
                                  await rpc("resolve_price_difference", { p_booking_id: r.booking_id, p_resolution: "waived", p_note: str(fd, "note") });
                                }}
                              />
                            )}
                          </div>
                        )}
                        {settled && <Chip tone="emerald">Settled</Chip>}
                      </Td>
                    </tr>
                  );
                })
              )}
            </Table>
          )}
        </Loaded>
      </Card>
    </div>
  );
}
