import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, Table, Tabs, Td, fmtDateTime, inputCls, rpc, rpcRows, str } from "@/ui";
import { BatteryTab, Form22Tab, JobCardsTab, TransitTab, YardOverview } from "./YardExtras";
import { OutletPicker } from "@/pages/ops/shared";

type Car = {
  vehicle_id: string;
  vin: string;
  car: string;
  outlet: string;
  outlet_id: string;
  status: string;
  location: string | null;
  last_kind: string | null;
  last_moved_at: string | null;
  days_since_move: number;
  last_battery_check: string | null;
  control: string | null;
  customer_name: string | null;
};
type Yard = { id: string; outlet_id: string; name: string };

const KINDS = [
  { id: "yard_move", name: "Moved in yard" },
  { id: "display", name: "To display" },
  { id: "workshop", name: "To workshop" },
  { id: "pdi", name: "To PDI bay" },
  { id: "wash", name: "Wash" },
  { id: "battery_check", name: "Battery check" },
  { id: "other", name: "Other" },
];

// Techwheels' vehicle location: where every yard car is, every move, and battery checks on cars standing long.
// Techwheels' Manage Yard and Form 22: overview against capacity, transit, every car's location,
// battery-change cases, job cards and Form 22 / CNG forms.
export default function YardPage() {
  const [outlet, setOutlet] = useState("");
  const [tab, setTab] = useState("overview");
  return (
    <div>
      <PageHeader title="Yard & Form 22" note="A delivered car moves to the Delivered yard by itself." actions={<OutletPicker value={outlet} onChange={setOutlet} />} />
      <Tabs
        current={tab}
        onChange={setTab}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "cars", label: "Cars & moves" },
          { id: "transit", label: "Transit" },
          { id: "battery", label: "Battery change" },
          { id: "jc", label: "Job cards" },
          { id: "form22", label: "Form 22 / CNG" },
        ]}
      />
      {tab === "overview" ? (
        <YardOverview outlet={outlet} />
      ) : tab === "cars" ? (
        <YardCars outlet={outlet} />
      ) : tab === "transit" ? (
        <TransitTab outlet={outlet} />
      ) : tab === "battery" ? (
        <BatteryTab outlet={outlet} />
      ) : tab === "jc" ? (
        <JobCardsTab />
      ) : (
        <Form22Tab outlet={outlet} />
      )}
    </div>
  );
}

function YardCars({ outlet }: { outlet: string }) {
  const [filter, setFilter] = useState("");
  const q = useQuery(() => rpcRows<Car>("yard_stock", { p_outlet_id: outlet || null }), [outlet]);
  const yards = useQuery(async () => must(await supabase.from("yards").select("id, outlet_id, name").eq("is_active", true).order("name")) as Yard[], []);
  const canMove = useRightGate("vehicle_location", "edit");
  const rows = useMemo(() => (q.data ?? []).filter((c) => !filter || `${c.vin} ${c.car} ${c.location} ${c.customer_name}`.toLowerCase().includes(filter.toLowerCase())), [q.data, filter]);

  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-sm text-slate-500">
        <input placeholder="Search VIN, model, customer" value={filter} onChange={(e) => setFilter(e.target.value)} className={`${inputCls} w-56`} />
        Physical cars not yet invoiced. Record every move; check the battery of cars standing over 15 days.
      </div>
      <Card>
        <Loaded q={q}>
          {() => (
            <Table head={["Car", "Where", "Last move", "Battery", "For", canMove ? "Record" : ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={6} text="No cars." />
              ) : (
                rows.map((c) => {
                  const batteryDue = !c.last_battery_check || Date.now() - new Date(c.last_battery_check).getTime() > 15 * 86_400_000;
                  return (
                    <tr key={c.vehicle_id}>
                      <Td>
                        <Link to={`/search?vehicle=${c.vehicle_id}`} className="font-mono text-xs hover:underline">
                          {c.vin}
                        </Link>
                        <div>{c.car}</div>
                        {c.control && <Chip tone="red">{c.control.replace("_", " ")}</Chip>}
                      </Td>
                      <Td>
                        {c.location ?? <span className="text-slate-400">Not recorded</span>}
                        <div className="text-xs text-slate-500">{c.outlet}</div>
                      </Td>
                      <Td muted>
                        {c.last_kind ? KINDS.find((k) => k.id === c.last_kind)?.name ?? c.last_kind : "—"}
                        <div className="text-xs">{c.last_moved_at ? fmtDateTime(c.last_moved_at) : `${c.days_since_move} days in stock`}</div>
                      </Td>
                      <Td>{batteryDue ? <Chip tone="amber">Check due</Chip> : <span className="text-xs text-slate-500">{fmtDateTime(c.last_battery_check)}</span>}</Td>
                      <Td muted>{c.customer_name ?? "Free"}</Td>
                      <Td>
                        {canMove && (
                          <ActionForm
                            label="Save"
                            hidden={{}}
                            fields={[
                              { name: "kind", placeholder: "What", options: KINDS, required: true, width: "w-32" },
                              { name: "yard", placeholder: "To", options: (yards.data ?? []).filter((y) => y.outlet_id === c.outlet_id).map((y) => ({ id: y.id, name: y.name })), width: "w-32" },
                              { name: "volt", placeholder: "Volts", type: "number", width: "w-16" },
                              { name: "note", placeholder: "Note", width: "w-28" },
                            ]}
                            action={async (fd) => {
                              await rpc("log_vehicle_movement", {
                                p_vehicle_id: c.vehicle_id,
                                p_kind: str(fd, "kind"),
                                p_yard_id: str(fd, "yard"),
                                p_note: str(fd, "note"),
                                p_battery_voltage: str(fd, "volt") ? Number(str(fd, "volt")) : null,
                              });
                            }}
                          />
                        )}
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
