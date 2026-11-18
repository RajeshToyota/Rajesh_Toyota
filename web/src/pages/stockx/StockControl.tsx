import { useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, Table, Td, fmtDateTime, inputCls, rpc, rpcRows, str } from "@/ui";

type Control = { id: string; vehicle_id: string; flag: string; reason: string; set_at: string; vehicles: { vin: string } | null; employees: { name: string } | null };
type Car = { vehicle_id: string; vin: string; car: string; outlet: string; control: string | null; customer_name: string | null };

const FLAGS = [
  { id: "blocked", name: "Blocked" },
  { id: "damaged", name: "Damaged" },
  { id: "demo", name: "Demo car" },
  { id: "management_hold", name: "Management hold" },
];

// Techwheels' stock control: take a car out of allotment (damage, demo use, a management hold).
export default function StockControl() {
  const active = useQuery(
    async () =>
      must(await supabase.from("stock_controls").select("id, vehicle_id, flag, reason, set_at, vehicles(vin), employees!stock_controls_set_by_fkey(name)").is("cleared_at", null).order("set_at", { ascending: false })) as unknown as Control[],
    [],
  );
  const cars = useQuery(() => rpcRows<Car>("yard_stock", { p_outlet_id: null }), []);
  const [vin, setVin] = useState("");
  const pick = useMemo(() => (cars.data ?? []).filter((c) => !c.control && !c.customer_name && vin.length >= 3 && c.vin.includes(vin.toUpperCase())).slice(0, 10), [cars.data, vin]);

  return (
    <div>
      <PageHeader title="Stock Control" note="A car under control cannot be allotted manually, by FIFO, by CTDMS match or by the pool." />
      <Card title="Put a car under control">
        <div className="space-y-2 px-3 py-2">
          <input value={vin} onChange={(e) => setVin(e.target.value)} placeholder="Type part of the VIN" className={`${inputCls} w-64 font-mono`} />
          {pick.map((c) => (
            <div key={c.vehicle_id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono text-xs">{c.vin}</span>
              <span className="text-slate-600">{c.car}</span>
              <ActionForm
                label="Control"
                hidden={{}}
                fields={[
                  { name: "flag", placeholder: "Flag", options: FLAGS, required: true, width: "w-36" },
                  { name: "reason", placeholder: "Reason", required: true, width: "w-56" },
                ]}
                action={async (fd) => {
                  await rpc("set_stock_control", { p_vehicle_id: c.vehicle_id, p_flag: str(fd, "flag"), p_reason: str(fd, "reason") });
                  setVin("");
                }}
              />
            </div>
          ))}
        </div>
      </Card>
      <Card title="Under control now">
        <Loaded q={active}>
          {(rows) => (
            <Table head={["VIN", "Flag", "Reason", "Since", ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={5} text="No cars under control." />
              ) : (
                rows.map((s) => (
                  <tr key={s.id}>
                    <Td>
                      <span className="font-mono text-xs">{s.vehicles?.vin}</span>
                    </Td>
                    <Td>
                      <Chip tone="red">{FLAGS.find((f) => f.id === s.flag)?.name}</Chip>
                    </Td>
                    <Td>{s.reason}</Td>
                    <Td muted>
                      {fmtDateTime(s.set_at)}
                      <div className="text-xs">{s.employees?.name}</div>
                    </Td>
                    <Td>
                      <ActionForm
                        tone="light"
                        label="Release"
                        hidden={{}}
                        fields={[{ name: "note", placeholder: "Note", width: "w-32" }]}
                        action={async (fd) => {
                          await rpc("clear_stock_control", { p_vehicle_id: s.vehicle_id, p_note: str(fd, "note") });
                        }}
                      />
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
