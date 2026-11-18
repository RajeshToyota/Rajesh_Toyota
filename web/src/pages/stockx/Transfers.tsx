import { useMemo, useState } from "react";
import { useQuery } from "@/lib/query";
import { can } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, RunButton, Table, Tabs, Td, fmtDateTime, inputCls, rpc, rpcRows, str } from "@/ui";
import { useOutlets } from "@/pages/ops/shared";

type Transfer = {
  id: string;
  vin: string;
  car: string;
  from_outlet: string;
  to_outlet: string;
  from_outlet_id: string;
  to_outlet_id: string;
  reason: string;
  status: string;
  requested_by: string | null;
  requested_at: string;
  decided_by: string | null;
  decision_note: string | null;
  received_at: string | null;
};
type Car = { vehicle_id: string; vin: string; car: string; outlet: string; outlet_id: string; customer_name: string | null };

const tone: Record<string, "amber" | "blue" | "emerald" | "slate" | "red"> = { requested: "amber", approved: "blue", received: "emerald", rejected: "red", cancelled: "slate" };

// Techwheels' stock transfers: a car moves between branches only after the sending branch approves,
// and belongs to the new branch once it arrives.
export default function Transfers() {
  const [open, setOpen] = useState("open");
  const q = useQuery(() => rpcRows<Transfer>("stock_transfer_list", { p_open_only: open === "open" }), [open]);
  const outlets = useOutlets();
  const cars = useQuery(() => rpcRows<Car>("yard_stock", { p_outlet_id: null }).catch(() => [] as Car[]), []);
  const [vin, setVin] = useState("");
  const pick = useMemo(() => (cars.data ?? []).filter((c) => vin.length >= 3 && c.vin.includes(vin.toUpperCase())).slice(0, 8), [cars.data, vin]);

  return (
    <div>
      <PageHeader title="Stock Transfers" note="Request a car from another branch, or send one of yours. Do the matching transfer in CTDMS too." />
      <Card title="New transfer">
        <div className="space-y-2 px-3 py-2">
          <input value={vin} onChange={(e) => setVin(e.target.value)} placeholder="Type part of the VIN" className={`${inputCls} w-64 font-mono`} />
          {pick.map((c) => (
            <div key={c.vehicle_id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono text-xs">{c.vin}</span>
              <span className="text-slate-600">
                {c.car} · at {c.outlet}
                {c.customer_name ? ` · for ${c.customer_name}` : ""}
              </span>
              <ActionForm
                label="Request"
                hidden={{}}
                fields={[
                  { name: "to", placeholder: "To branch", options: (outlets.data ?? []).filter((o) => o.id !== c.outlet_id), required: true, width: "w-48" },
                  { name: "reason", placeholder: "Why", required: true, width: "w-56" },
                ]}
                action={async (fd) => {
                  await rpc("request_stock_transfer", { p_vehicle_id: c.vehicle_id, p_to_outlet_id: str(fd, "to"), p_reason: str(fd, "reason") });
                  setVin("");
                }}
              />
            </div>
          ))}
        </div>
      </Card>
      <Tabs current={open} onChange={setOpen} tabs={[{ id: "open", label: "Open" }, { id: "all", label: "All" }]} />
      <Card>
        <Loaded q={q}>
          {(rows) => (
            <Table head={["Car", "From → To", "Reason", "Status", ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={5} text="No transfers." />
              ) : (
                rows.map((t) => (
                  <tr key={t.id}>
                    <Td>
                      <span className="font-mono text-xs">{t.vin}</span>
                      <div>{t.car}</div>
                    </Td>
                    <Td>
                      {t.from_outlet} → {t.to_outlet}
                    </Td>
                    <Td muted>
                      {t.reason}
                      <div className="text-xs">
                        {t.requested_by} · {fmtDateTime(t.requested_at)}
                      </div>
                    </Td>
                    <Td>
                      <Chip tone={tone[t.status]}>{t.status}</Chip>
                      {t.decision_note && <div className="text-xs text-slate-500">{t.decision_note}</div>}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {t.status === "requested" && can("stock_transfers", "approve") && (
                          <>
                            <RunButton label="Approve" run={() => rpc("move_stock_transfer", { p_transfer_id: t.id, p_status: "approved" })} />
                            <ActionForm
                              tone="danger"
                              label="Reject"
                              hidden={{}}
                              fields={[{ name: "why", placeholder: "Why", required: true, width: "w-24" }]}
                              action={async (fd) => {
                                await rpc("move_stock_transfer", { p_transfer_id: t.id, p_status: "rejected", p_note: str(fd, "why") });
                              }}
                            />
                          </>
                        )}
                        {t.status === "approved" && <RunButton label="Car arrived" run={() => rpc("move_stock_transfer", { p_transfer_id: t.id, p_status: "received" })} />}
                        {(t.status === "requested" || t.status === "approved") && (
                          <RunButton tone="light" label="Cancel" run={() => rpc("move_stock_transfer", { p_transfer_id: t.id, p_status: "cancelled" })} />
                        )}
                      </div>
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
