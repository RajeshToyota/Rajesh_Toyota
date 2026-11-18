import { useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, Table, Td, fmtDateTime, inputCls, rpc, rpcRows, str } from "@/ui";

type Control = { id: string; vehicle_id: string; flag: string; state: string; reason_code: string | null; effective_to: string | null; reason: string; set_at: string; vehicles: { vin: string } | null; employees: { name: string } | null };
type Car = { vehicle_id: string; vin: string; car: string; outlet: string; control: string | null; customer_name: string | null };

const FLAGS = [
  { id: "blocked", name: "Blocked" },
  { id: "damaged", name: "Damaged" },
  { id: "demo", name: "Demo car" },
  { id: "management_hold", name: "Management hold" },
  { id: "added", name: "Added back" },
];
const REASONS = [
  { id: "cancelled_billing", name: "Billing cancelled" },
  { id: "demo_in_use", name: "Demo in use" },
  { id: "demo_on_sale", name: "Demo on sale" },
  { id: "management_hold", name: "Management hold" },
  { id: "management_release", name: "Management release" },
  { id: "damage", name: "Damage" },
  { id: "stna", name: "STNA" },
  { id: "other", name: "Other" },
];

// Techwheels' stock control: take a car out of allotment (damage, demo use, a management hold).
export default function StockControl() {
  const active = useQuery(
    async () =>
      must(await supabase.from("stock_controls").select("id, vehicle_id, flag, state, reason_code, effective_to, reason, set_at, vehicles(vin), employees!stock_controls_set_by_fkey(name)").is("cleared_at", null).order("set_at", { ascending: false })) as unknown as Control[],
    [],
  );
  const cars = useQuery(() => rpcRows<Car>("yard_stock", { p_outlet_id: null }), []);
  const [vin, setVin] = useState("");
  const pick = useMemo(() => (cars.data ?? []).filter((c) => !c.control && !c.customer_name && vin.length >= 3 && c.vin.includes(vin.toUpperCase())).slice(0, 10), [cars.data, vin]);
  // Cars that left the report (yard_stock does not list them) can be added back by full VIN.
  const [addVin, setAddVin] = useState("");

  return (
    <div>
      <PageHeader
        title="Stock Control"
        note="Deduct takes a car out of free stock (no allotment of any kind); Add puts back a car the CTDMS report no longer lists, e.g. after a cancelled billing (Outlet Head). An end date makes the entry lapse by itself."
      />
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
                  { name: "code", placeholder: "Reason", options: REASONS, required: true, width: "w-40" },
                  { name: "reason", placeholder: "Details", required: true, width: "w-56" },
                  { name: "until", placeholder: "Until", type: "date", width: "w-36" },
                ]}
                action={async (fd) => {
                  await rpc("set_stock_control_v2", { p_vehicle_id: c.vehicle_id, p_state: "deduct", p_reason_code: str(fd, "code"), p_reason: str(fd, "reason"), p_effective_to: str(fd, "until") });
                  setVin("");
                }}
              />
            </div>
          ))}
        </div>
      </Card>
      <Card title="Add a car back to free stock" note="For a car the CTDMS report no longer lists but which is in our yard and free to sell.">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <input value={addVin} onChange={(e) => setAddVin(e.target.value.toUpperCase())} placeholder="Full VIN" className={`${inputCls} w-64 font-mono`} />
          <ActionForm
            label="Add back"
            hidden={{}}
            fields={[
              { name: "code", placeholder: "Reason", options: REASONS, required: true, width: "w-40" },
              { name: "reason", placeholder: "Details", required: true, width: "w-56" },
            ]}
            action={async (fd) => {
              const { data } = await supabase.from("vehicles").select("id").eq("vin", addVin).maybeSingle();
              if (!data) throw new Error("No car with that VIN");
              await rpc("set_stock_control_v2", { p_vehicle_id: data.id, p_state: "add", p_reason_code: str(fd, "code"), p_reason: str(fd, "reason") });
              setAddVin("");
            }}
          />
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
                      <Chip tone={s.state === "add" ? "emerald" : "red"}>{s.state === "add" ? "Added" : "Deducted"}</Chip>{" "}
                      {REASONS.find((r) => r.id === s.reason_code)?.name ?? FLAGS.find((f) => f.id === s.flag)?.name}
                      {s.effective_to && <div className="text-xs text-slate-500">until {s.effective_to}</div>}
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
