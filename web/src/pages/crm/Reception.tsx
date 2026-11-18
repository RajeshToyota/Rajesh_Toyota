import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@/lib/query";
import { useCurrentEmployee } from "@/lib/auth";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, ErrorBox, Loaded, PageHeader, Table, Td, fmtDateTime, inputCls, rpc, rpcRows, str, todayIst } from "@/ui";
import { PURPOSES, TEMPS, label, useConsultants, useModels } from "./shared";

type Walkin = {
  id: string;
  visited_at: string;
  outlet: string;
  customer_name: string;
  mobile: string;
  visitors: number;
  purpose: string;
  model: string | null;
  source: string | null;
  assigned_to: string | null;
  assigned_employee_id: string | null;
  status: "waiting" | "attended" | "converted" | "left";
  enquiry_id: string | null;
  notes: string | null;
  left_reason: string | null;
  minutes_waiting: number | null;
};

const statusTone = { waiting: "amber", attended: "blue", converted: "emerald", left: "slate" } as const;

// Techwheels' reception kiosk: the front desk logs each walk-in and hands it to a consultant; the
// consultant meets them and turns the visit into an enquiry.
export default function Reception() {
  const [date, setDate] = useState(todayIst());
  const [notice, setNotice] = useState<string | null>(null);
  const q = useQuery(() => rpcRows<Walkin>("walkin_register", { p_date: date }), [date]);
  const canRecord = useRightGate("reception", "create");
  const me = useCurrentEmployee();
  const models = useModels();
  const consultants = useConsultants();

  return (
    <div>
      <PageHeader
        title="Reception"
        note="Every walk-in, who is waiting and for how long. A returning customer goes back to the consultant who has their enquiry."
        actions={<input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />}
      />
      {canRecord && (
        <Card title="New walk-in">
          <div className="px-3 py-2">
            {notice && <p className="mb-2 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-800">{notice}</p>}
            <ActionForm
              label="Record"
              hidden={{}}
              fields={[
                { name: "customer_name", placeholder: "Customer name", required: true, width: "w-48" },
                { name: "mobile", placeholder: "Mobile", required: true, width: "w-32" },
                { name: "visitors", placeholder: "People", type: "number", initial: "1", width: "w-20" },
                { name: "purpose", placeholder: "Purpose", options: PURPOSES, width: "w-40" },
                { name: "model_id", placeholder: "Model", options: models.data ?? [], width: "w-40" },
                { name: "source", placeholder: "How they heard of us", width: "w-44" },
                {
                  name: "assigned_employee_id",
                  placeholder: "Hand to…",
                  options: (consultants.data ?? []).map((c) => ({ id: c.id, name: `${c.name}${c.waiting ? ` (${c.waiting} waiting)` : ""}` })),
                  width: "w-52",
                },
              ]}
              action={async (fd) => {
                const p = Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]));
                const [r] = await rpc<{ walkin_id: string; open_enquiry_id: string | null; open_enquiry_owner: string | null }[]>("record_walkin", { p });
                setNotice(r?.open_enquiry_id ? `Returning customer: handed to ${r.open_enquiry_owner}, who has their enquiry.` : null);
              }}
            />
          </div>
        </Card>
      )}
      <Card title="Walk-in register">
        <Loaded q={q}>
          {(rows) => (
            <Table head={["Time", "Customer", "Visit", "With", "Status", ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={6} text="No walk-ins recorded for this day." />
              ) : (
                rows.map((w) => (
                  <tr key={w.id}>
                    <Td muted>{new Date(w.visited_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</Td>
                    <Td>
                      <span className="font-medium">{w.customer_name}</span>
                      <div className="text-xs text-slate-500">
                        {w.mobile} · {w.visitors} {w.visitors > 1 ? "people" : "person"}
                      </div>
                    </Td>
                    <Td>
                      {label(PURPOSES, w.purpose)}
                      <div className="text-xs text-slate-500">{[w.model, w.source].filter(Boolean).join(" · ")}</div>
                    </Td>
                    <Td>
                      {w.assigned_to ?? <span className="text-slate-400">Not handed over</span>}
                      {w.status === "waiting" && !w.assigned_employee_id && canRecord && (
                        <ActionForm
                          label="Hand over"
                          hidden={{}}
                          fields={[{ name: "to", placeholder: "Consultant", options: (consultants.data ?? []).map((c) => ({ id: c.id, name: c.name })), required: true, width: "w-40" }]}
                          action={async (fd) => {
                            await rpc("assign_walkin", { p_walkin_id: w.id, p_employee_id: str(fd, "to") });
                          }}
                        />
                      )}
                    </Td>
                    <Td>
                      <Chip tone={statusTone[w.status]}>{w.status}</Chip>
                      {w.minutes_waiting != null && (
                        <div className={`text-xs ${w.minutes_waiting > 10 ? "text-red-700" : "text-slate-500"}`}>{w.minutes_waiting} min</div>
                      )}
                      {w.left_reason && <div className="text-xs text-slate-500">{w.left_reason}</div>}
                      {w.enquiry_id && (
                        <Link to="/followups" className="text-xs underline">
                          Enquiry
                        </Link>
                      )}
                    </Td>
                    <Td>
                      {(w.status === "waiting" || w.status === "attended") && (
                        <Attend walkin={w} isMine={w.assigned_employee_id === me?.id || !w.assigned_employee_id} models={models.data ?? []} />
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

function Attend({ walkin, isMine, models }: { walkin: Walkin; isMine: boolean; models: { id: string; name: string }[] }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1">
      {error && <ErrorBox message={error} />}
      {isMine &&
        (walkin.enquiry_id ? (
          <ActionForm
            label="Meet"
            hidden={{}}
            action={async () => {
              await rpc("attend_walkin", { p_walkin_id: walkin.id });
            }}
          />
        ) : (
          <ActionForm
            label="Create enquiry"
            hidden={{}}
            fields={[
              { name: "model_id", placeholder: "Model", options: models, required: true, width: "w-32" },
              { name: "temperature", placeholder: "Temp.", options: TEMPS, width: "w-24" },
            ]}
            action={async (fd) => {
              setError(null);
              await rpc("attend_walkin", {
                p_walkin_id: walkin.id,
                p_enquiry: { model_id: str(fd, "model_id"), temperature: str(fd, "temperature") ?? "WRM" },
              });
            }}
          />
        ))}
      <ActionForm
        tone="light"
        label="Left"
        hidden={{}}
        fields={[{ name: "reason", placeholder: "Why", required: true, width: "w-24" }]}
        action={async (fd) => {
          await rpc("close_walkin", { p_walkin_id: walkin.id, p_reason: str(fd, "reason") });
        }}
      />
    </div>
  );
}
