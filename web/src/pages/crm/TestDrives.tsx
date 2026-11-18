import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { useCurrentEmployee } from "@/lib/auth";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, RunButton, Table, Td, fmtDateTime, inputCls, rpc, rpcRows, str, todayIst } from "@/ui";
import { localDateTime, toIso, useModels } from "./shared";

type Drive = {
  id: string;
  vehicle_id: string;
  reg_no: string;
  vehicle: string | null;
  outlet: string;
  customer_name: string;
  mobile: string | null;
  consultant: string;
  scheduled_at: string;
  duration_min: number;
  location: string;
  status: "scheduled" | "out" | "completed" | "cancelled" | "no_show";
  start_km: number | null;
  end_km: number | null;
  rating: number | null;
  feedback: string | null;
};
type Car = { id: string; reg_no: string; status: string; odometer_km: number | null; outlet_id: string; variants: { name: string } | null; models: { name: string } | null };

const tone = { scheduled: "amber", out: "blue", completed: "emerald", cancelled: "slate", no_show: "red" } as const;

// Techwheels' test drive desk: the demo fleet, the day's drives per car, licence check, kilometres and feedback.
export default function TestDrives() {
  const [date, setDate] = useState(todayIst());
  const drives = useQuery(() => rpcRows<Drive>("test_drive_schedule", { p_date: date }), [date]);
  const fleet = useQuery(
    async () =>
      must(await supabase.from("test_drive_vehicles").select("id, reg_no, status, odometer_km, outlet_id, variants(name), models(name)").neq("status", "retired").order("reg_no")) as unknown as Car[],
    [],
  );
  const canBook = useRightGate("test_drive", "create");
  const models = useModels();
  const me = useCurrentEmployee();
  const isBackOffice = me?.roleRank != null && me.roleRank <= 3;
  const carName = (c: Car) => `${c.reg_no} · ${c.models?.name ?? ""} ${c.variants?.name ?? ""}`.trim();

  return (
    <div>
      <PageHeader
        title="Test Drives"
        note="Book a demo car without clashes. The drive starts only with the customer's driving licence; finishing it marks the enquiry."
        actions={<input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />}
      />
      {canBook && (
        <Card title="Book a test drive" note="From an enquiry, use the customer's mobile below; walk-ups can be booked by name.">
          <div className="px-3 py-2">
            <ActionForm
              label="Book"
              hidden={{}}
              fields={[
                { name: "car", placeholder: "Demo car", options: (fleet.data ?? []).filter((c) => c.status === "active").map((c) => ({ id: c.id, name: carName(c) })), required: true, width: "w-64" },
                { name: "at", placeholder: "When", type: "datetime-local", initial: localDateTime(new Date(Date.now() + 3_600_000)), required: true, width: "w-44" },
                { name: "name", placeholder: "Customer name", required: true, width: "w-44" },
                { name: "mobile", placeholder: "Mobile", width: "w-32" },
                { name: "mins", placeholder: "Minutes", type: "number", initial: "30", width: "w-20" },
                { name: "where", placeholder: "Where", options: [{ id: "showroom", name: "From showroom" }, { id: "home", name: "At home" }], width: "w-36" },
              ]}
              action={async (fd) => {
                await rpc("schedule_test_drive", {
                  p_vehicle_id: str(fd, "car"),
                  p_scheduled_at: toIso(str(fd, "at")),
                  p_customer_name: str(fd, "name"),
                  p_mobile: str(fd, "mobile"),
                  p_duration_min: Number(str(fd, "mins") ?? 30),
                  p_location: str(fd, "where") ?? "showroom",
                });
              }}
            />
          </div>
        </Card>
      )}
      <Card title="Drives">
        <Loaded q={drives}>
          {(rows) => (
            <Table head={["Car", "When", "Customer", "Status", ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={5} text="No test drives on this day." />
              ) : (
                rows.map((d) => (
                  <tr key={d.id}>
                    <Td>
                      <span className="font-mono">{d.reg_no}</span>
                      <div className="text-xs text-slate-500">{d.vehicle}</div>
                    </Td>
                    <Td muted>
                      {fmtDateTime(d.scheduled_at)}
                      <div className="text-xs">
                        {d.duration_min} min · {d.location}
                      </div>
                    </Td>
                    <Td>
                      {d.customer_name}
                      <div className="text-xs text-slate-500">{[d.mobile, d.consultant].filter(Boolean).join(" · ")}</div>
                    </Td>
                    <Td>
                      <Chip tone={tone[d.status]}>{d.status.replace("_", " ")}</Chip>
                      {d.status === "completed" && (
                        <div className="text-xs text-slate-500">
                          {(d.end_km ?? 0) - (d.start_km ?? 0)} km{d.rating ? ` · ${"★".repeat(d.rating)}` : ""}
                          {d.feedback && <div>{d.feedback}</div>}
                        </div>
                      )}
                    </Td>
                    <Td>
                      {d.status === "scheduled" && (
                        <div className="flex flex-col gap-1">
                          <ActionForm
                            label="Start"
                            hidden={{}}
                            fields={[
                              { name: "dl", placeholder: "Driving licence no.", required: true, width: "w-40" },
                              { name: "km", placeholder: "Odometer", type: "number", required: true, width: "w-24" },
                            ]}
                            action={async (fd) => {
                              await rpc("start_test_drive", { p_id: d.id, p_dl_number: str(fd, "dl"), p_start_km: Number(str(fd, "km")) });
                            }}
                          />
                          <div className="flex gap-1">
                            <RunButton tone="light" label="No show" run={() => rpc("cancel_test_drive", { p_id: d.id, p_status: "no_show" })} />
                            <RunButton tone="danger" label="Cancel" run={() => rpc("cancel_test_drive", { p_id: d.id, p_status: "cancelled" })} />
                          </div>
                        </div>
                      )}
                      {d.status === "out" && (
                        <ActionForm
                          label="Back"
                          hidden={{}}
                          fields={[
                            { name: "km", placeholder: "Odometer", type: "number", required: true, width: "w-24" },
                            { name: "rating", placeholder: "Rating", options: [5, 4, 3, 2, 1].map((n) => ({ id: String(n), name: "★".repeat(n) })), width: "w-28" },
                            { name: "feedback", placeholder: "Feedback", width: "w-44" },
                          ]}
                          action={async (fd) => {
                            await rpc("end_test_drive", {
                              p_id: d.id,
                              p_end_km: Number(str(fd, "km")),
                              p_rating: str(fd, "rating") ? Number(str(fd, "rating")) : null,
                              p_feedback: str(fd, "feedback"),
                            });
                          }}
                        />
                      )}
                    </Td>
                  </tr>
                ))
              )}
            </Table>
          )}
        </Loaded>
      </Card>
      <Card title="Demo fleet">
        <Loaded q={fleet}>
          {(cars) => (
            <Table head={["Registration", "Car", "Odometer", "Status", ""]}>
              {cars.length === 0 ? (
                <EmptyRow cols={5} text="No demo cars yet." />
              ) : (
                cars.map((c) => (
                  <tr key={c.id}>
                    <Td>
                      <span className="font-mono">{c.reg_no}</span>
                    </Td>
                    <Td>{`${c.models?.name ?? ""} ${c.variants?.name ?? ""}`}</Td>
                    <Td right>{c.odometer_km?.toLocaleString("en-IN") ?? "—"} km</Td>
                    <Td>
                      <Chip tone={c.status === "active" ? "emerald" : "amber"}>{c.status}</Chip>
                    </Td>
                    <Td>
                      {isBackOffice && (
                        <RunButton
                          tone="light"
                          label={c.status === "active" ? "Send for maintenance" : "Back in service"}
                          run={() => rpc("save_test_drive_vehicle", { p_id: c.id, p: { status: c.status === "active" ? "maintenance" : "active" } })}
                        />
                      )}
                    </Td>
                  </tr>
                ))
              )}
            </Table>
          )}
        </Loaded>
        {isBackOffice && (
          <div className="border-t border-slate-100 px-3 py-2">
            <ActionForm
              label="Add demo car"
              hidden={{}}
              fields={[
                { name: "reg_no", placeholder: "Registration no.", required: true, width: "w-36" },
                { name: "vin", placeholder: "VIN", width: "w-44" },
                { name: "model_id", placeholder: "Model", options: models.data ?? [], required: true, width: "w-40" },
                { name: "odometer_km", placeholder: "Odometer", type: "number", width: "w-24" },
              ]}
              action={async (fd) => {
                const p = Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]));
                await rpc("save_test_drive_vehicle", { p_id: null, p });
              }}
            />
          </div>
        )}
      </Card>
    </div>
  );
}

