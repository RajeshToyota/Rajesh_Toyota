import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, Loaded, RunButton, Table, Td, fmtDate, rpc, rpcRows, str, titleCase } from "@/ui";

type Overview = { outlet: string; yard_id: string | null; yard: string; kind: string; capacity: number | null; cars: number; allotted: number };

// Cars per yard against capacity, and cars with no yard recorded (Techwheels' Yard Overview).
export function YardOverview({ outlet }: { outlet: string }) {
  const canSet = useRightGate("vehicle_location", "approve");
  const q = useQuery(() => rpcRows<Overview>("yard_overview", { p_outlet_id: outlet || null }), [outlet]);
  return (
    <Card>
      <Loaded q={q}>
        {(rows) => (
          <Table head={["Branch", "Yard", "Cars", "Allotted", "Capacity", ""]}>
            {rows.length === 0 ? (
              <EmptyRow cols={6} text="No yards." />
            ) : (
              rows.map((r) => {
                const full = r.capacity != null && r.cars >= r.capacity;
                return (
                  <tr key={`${r.outlet}-${r.yard}`}>
                    <Td muted>{r.outlet}</Td>
                    <Td>
                      {r.yard} {r.kind !== "normal" && r.kind !== "none" && <Chip>{r.kind}</Chip>}
                    </Td>
                    <Td right>{r.kind === "none" && r.cars > 0 ? <Chip tone="amber">{r.cars}</Chip> : r.cars}</Td>
                    <Td right>{r.allotted}</Td>
                    <Td right>{r.capacity == null ? "—" : full ? <Chip tone="red">{r.capacity} (full)</Chip> : r.capacity}</Td>
                    <Td>
                      {canSet && r.yard_id && (
                        <ActionForm
                          tone="light"
                          label="Set"
                          hidden={{}}
                          fields={[{ name: "cap", placeholder: "Capacity", type: "number", width: "w-20" }]}
                          action={async (fd) => {
                            await rpc("set_yard_capacity", { p_yard_id: r.yard_id, p_capacity: str(fd, "cap") ? Number(str(fd, "cap")) : null });
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
  );
}

type TransitCar = {
  id: string;
  vin: string;
  outlet_id: string;
  location: string | null;
  tkm_invoice_date: string | null;
  outlets: { name: string } | null;
};
type TransitDetail = { vin: string; trailer_no: string | null; transporter: string | null; current_location: string | null; expected_arrival: string | null };

// Cars in transit with the dispatch details, and receiving them into a yard.
export function TransitTab({ outlet }: { outlet: string }) {
  const canEdit = useRightGate("vehicle_location", "edit");
  const q = useQuery(async () => {
    let query = supabase.from("vehicles").select("id, vin, outlet_id, location, tkm_invoice_date, outlets(name)").eq("source", "transit").neq("status", "billed").eq("missing_from_report", false);
    if (outlet) query = query.eq("outlet_id", outlet);
    const cars = must(await query.order("tkm_invoice_date")) as unknown as TransitCar[];
    const details = cars.length
      ? (must(await supabase.from("vehicle_transit_details").select("vin, trailer_no, transporter, current_location, expected_arrival").in("vin", cars.map((c) => c.vin))) as TransitDetail[])
      : [];
    const yards = must(await supabase.from("yards").select("id, outlet_id, name").eq("is_active", true).neq("kind", "delivered").order("name")) as { id: string; outlet_id: string; name: string }[];
    return { cars, details: new Map(details.map((d) => [d.vin, d])), yards };
  }, [outlet]);
  const [file, setFile] = useState<string | null>(null);

  return (
    <>
      {canEdit && (
        <Card title="Import the dispatch file" note="CSV columns: vin, tkm_invoice_no, tkm_invoice_date, trailer_no, transporter, current_location, expected_arrival. The whole file is refused if a VIN is wrong.">
          <div className="flex items-center gap-2 px-3 py-2 text-sm">
            <input
              type="file"
              accept=".csv"
              className="text-xs"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const { parseCsv } = await import("@/lib/csv");
                const rows = parseCsv(await f.text());
                const head = rows[0].map((h) => h.trim().toLowerCase());
                const data = rows.slice(1).filter((r) => r.some((c) => c.trim())).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
                try {
                  const n = await rpc<number>("import_transit_details", { p_rows: data });
                  setFile(`${n} cars updated.`);
                  q.reload();
                } catch (err) {
                  setFile(err instanceof Error ? err.message : String(err));
                }
                e.target.value = "";
              }}
            />
            {file && <span className="text-slate-600">{file}</span>}
          </div>
        </Card>
      )}
      <Card title="In transit">
        <Loaded q={q}>
          {({ cars, details, yards }) => (
            <Table head={["VIN", "Branch", "TKM invoice", "Trailer / transporter", "Where now / ETA", ""]}>
              {cars.length === 0 ? (
                <EmptyRow cols={6} text="No cars in transit." />
              ) : (
                cars.map((c) => {
                  const d = details.get(c.vin);
                  return (
                    <tr key={c.id}>
                      <Td>
                        <span className="font-mono text-xs">{c.vin}</span>
                      </Td>
                      <Td muted>{c.outlets?.name}</Td>
                      <Td muted>{fmtDate(c.tkm_invoice_date)}</Td>
                      <Td muted>{[d?.trailer_no, d?.transporter].filter(Boolean).join(" · ") || "—"}</Td>
                      <Td muted>
                        {d?.current_location ?? "—"}
                        {d?.expected_arrival && <div className="text-xs">ETA {fmtDate(d.expected_arrival)}</div>}
                      </Td>
                      <Td>
                        {canEdit && (
                          <ActionForm
                            label="Received"
                            hidden={{}}
                            fields={[
                              { name: "yard", placeholder: "Yard", options: yards.filter((y) => y.outlet_id === c.outlet_id).map((y) => ({ id: y.id, name: y.name })), required: true, width: "w-32" },
                              { name: "driver", placeholder: "Driver", width: "w-24" },
                              { name: "papers", placeholder: "Papers", options: [{ id: "yes", name: "Papers OK" }, { id: "no", name: "Papers missing" }], width: "w-28" },
                            ]}
                            action={async (fd) => {
                              await rpc("receive_from_transit", {
                                p_vehicle_id: c.id,
                                p_yard_id: str(fd, "yard"),
                                p_driver: str(fd, "driver"),
                                p_paper_check: str(fd, "papers") ? str(fd, "papers") === "yes" : null,
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
    </>
  );
}

type Battery = { vehicle_id: string; vin: string; car: string; outlet: string; customer_name: string; tkm_invoice_date: string; age_days: number; status: string; note: string | null };
const BATTERY = [
  { id: "pending", name: "Pending" },
  { id: "approval_mail_sent", name: "Approval mail sent" },
  { id: "approval_received", name: "Approval received" },
  { id: "done", name: "Battery changed" },
];

// Allotted cars, not yet invoiced, whose TKM invoice is 90+ days old: the battery needs TKM's approval.
export function BatteryTab({ outlet }: { outlet: string }) {
  const q = useQuery(() => rpcRows<Battery>("battery_change_list", { p_outlet_id: outlet || null }), [outlet]);
  return (
    <Card>
      <Loaded q={q}>
        {(rows) => (
          <Table head={["Car", "Customer", "TKM invoice", "Status", ""]}>
            {rows.length === 0 ? (
              <EmptyRow cols={5} text="No allotted car is 90 days old." />
            ) : (
              rows.map((r) => (
                <tr key={r.vehicle_id}>
                  <Td>
                    <span className="font-mono text-xs">{r.vin}</span>
                    <div>{r.car}</div>
                  </Td>
                  <Td>{r.customer_name}</Td>
                  <Td>
                    {fmtDate(r.tkm_invoice_date)} <Chip tone="red">{r.age_days} days</Chip>
                  </Td>
                  <Td>
                    <Chip tone={r.status === "done" ? "emerald" : r.status === "pending" ? "amber" : "blue"}>{BATTERY.find((b) => b.id === r.status)?.name}</Chip>
                    {r.note && <div className="text-xs text-slate-500">{r.note}</div>}
                  </Td>
                  <Td>
                    <ActionForm
                      tone="light"
                      label="Update"
                      hidden={{}}
                      fields={[
                        { name: "status", placeholder: "Status", options: BATTERY, required: true, width: "w-40" },
                        { name: "note", placeholder: "Note", width: "w-32" },
                      ]}
                      action={async (fd) => {
                        await rpc("set_battery_change_status", { p_vehicle_id: r.vehicle_id, p_status: str(fd, "status"), p_note: str(fd, "note") });
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
  );
}

type JobCard = { id: string; jc_no: string | null; opened_on: string; closed_on: string | null; note: string | null; vehicles: { vin: string } | null };

export function JobCardsTab() {
  const [vin, setVin] = useState("");
  const q = useQuery(
    async () =>
      must(await supabase.from("vehicle_job_cards").select("id, jc_no, opened_on, closed_on, note, vehicles(vin)").order("opened_on", { ascending: false }).limit(300)) as unknown as JobCard[],
    [],
  );
  const today = Date.now();
  return (
    <>
      <Card title="Open a job card">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <input className="rounded-md border border-slate-300 px-2 py-1 text-sm font-mono" placeholder="Full VIN" value={vin} onChange={(e) => setVin(e.target.value.toUpperCase())} />
          <ActionForm
            label="Open"
            hidden={{}}
            fields={[
              { name: "jc", placeholder: "Job card no.", required: true, width: "w-32" },
              { name: "note", placeholder: "Work", width: "w-40" },
            ]}
            action={async (fd) => {
              const { data } = await supabase.from("vehicles").select("id").eq("vin", vin).maybeSingle();
              if (!data) throw new Error("No car with that VIN");
              await rpc("open_job_card", { p_vehicle_id: data.id, p_jc_no: str(fd, "jc"), p_note: str(fd, "note") });
              setVin("");
              q.reload();
            }}
          />
        </div>
      </Card>
      <Card>
        <Loaded q={q}>
          {(rows) => (
            <Table head={["VIN", "Job card", "Opened", "Ageing", "Closed", ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={6} text="No job cards." />
              ) : (
                rows.map((j) => {
                  const age = Math.floor(((j.closed_on ? new Date(j.closed_on).getTime() : today) - new Date(j.opened_on).getTime()) / 86_400_000);
                  return (
                    <tr key={j.id}>
                      <Td>
                        <span className="font-mono text-xs">{j.vehicles?.vin}</span>
                      </Td>
                      <Td>
                        {j.jc_no}
                        <div className="text-xs text-slate-500">{j.note}</div>
                      </Td>
                      <Td muted>{fmtDate(j.opened_on)}</Td>
                      <Td>{j.closed_on ? `${age} days` : <Chip tone={age > 3 ? "red" : "amber"}>{age} days open</Chip>}</Td>
                      <Td muted>{fmtDate(j.closed_on)}</Td>
                      <Td>{!j.closed_on && <RunButton tone="light" label="Close" run={async () => { await rpc("close_job_card", { p_job_card_id: j.id }); q.reload(); }} />}</Td>
                    </tr>
                  );
                })
              )}
            </Table>
          )}
        </Loaded>
      </Card>
    </>
  );
}

type Pending = { vehicle_id: string; vin: string; car: string; outlet: string; status: string; customer_name: string | null; needs_cng: boolean; has_form22: boolean; has_cng: boolean };

// Form 22 (and the CNG form on CNG cars) per car, until the car is delivered.
export function Form22Tab({ outlet }: { outlet: string }) {
  const canEdit = useRightGate("vehicle_location", "edit");
  const q = useQuery(() => rpcRows<Pending>("form22_pending", { p_outlet_id: outlet || null }), [outlet]);
  async function upload(vehicleId: string, docType: string, file: File) {
    const path = `${vehicleId}/${docType}-${Date.now()}-${file.name.replace(/[^\w.-]+/g, "_")}`;
    const { error } = await supabase.storage.from("vehicle-documents").upload(path, file);
    if (error) throw new Error(error.message);
    await rpc("set_vehicle_document", { p_vehicle_id: vehicleId, p_doc_type: docType, p_storage_path: path });
  }
  return (
    <Card note="Cars still missing Form 22, or the CNG form on a CNG car. Delivered cars drop off the list.">
      <Loaded q={q}>
        {(rows) => (
          <Table head={["Car", "Status", "Customer", "Form 22", "CNG form"]}>
            {rows.length === 0 ? (
              <EmptyRow cols={5} text="Every car has its forms." />
            ) : (
              rows.map((r) => (
                <tr key={r.vehicle_id}>
                  <Td>
                    <span className="font-mono text-xs">{r.vin}</span>
                    <div>{r.car}</div>
                    <div className="text-xs text-slate-500">{r.outlet}</div>
                  </Td>
                  <Td>{titleCase(r.status)}</Td>
                  <Td muted>{r.customer_name ?? "Free"}</Td>
                  {(["form_22", "cng_form"] as const).map((t) => {
                    const has = t === "form_22" ? r.has_form22 : r.has_cng;
                    if (t === "cng_form" && !r.needs_cng) return <Td key={t} muted>Not CNG</Td>;
                    return (
                      <Td key={t}>
                        {has ? (
                          <Chip tone="emerald">Uploaded</Chip>
                        ) : canEdit ? (
                          <input
                            type="file"
                            accept="image/*,application/pdf"
                            className="text-xs"
                            onChange={async (e) => {
                              const f = e.target.files?.[0];
                              if (!f) return;
                              try {
                                await upload(r.vehicle_id, t, f);
                                q.reload();
                              } catch (err) {
                                alert(err instanceof Error ? err.message : String(err));
                              }
                            }}
                          />
                        ) : (
                          <Chip tone="amber">Missing</Chip>
                        )}
                      </Td>
                    );
                  })}
                </tr>
              ))
            )}
          </Table>
        )}
      </Loaded>
    </Card>
  );
}
