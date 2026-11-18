import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@/lib/query";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, Table, Tabs, Td, fmtDateTime, rpc, rpcRows, str } from "@/ui";
import { CHANNELS, OUTCOMES, TEMPS, label, localDateTime, toIso } from "./shared";

type Row = {
  enquiry_id: string;
  customer_name: string;
  mobile: string;
  model: string | null;
  temperature: string;
  stage: string;
  source: string | null;
  assigned_to: string;
  next_followup_at: string | null;
  last_followup_at: string | null;
  last_outcome: string | null;
  last_note: string | null;
  followups: number;
};
type History = { id: string; created_at: string; employee: string; channel: string; outcome: string; note: string | null; temperature: string | null };

const tempTone = (t: string) => (t === "HOT" ? "red" : t === "WRM" ? "amber" : "blue");

// Techwheels' lead follow-up: every open enquiry has a next date; log each contact and set the next.
export default function Followups() {
  const [when, setWhen] = useState("today");
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery(() => rpcRows<Row>("my_followups", { p_when: when }), [when]);
  const now = Date.now();

  return (
    <div>
      <PageHeader title="My Follow-ups" note="Open enquiries of you and your team, by next follow-up. Log each contact and set the next date." />
      <Tabs
        current={when}
        onChange={setWhen}
        tabs={[
          { id: "overdue", label: "Overdue" },
          { id: "today", label: "Due today" },
          { id: "upcoming", label: "Next 7 days" },
          { id: "all", label: "All open" },
        ]}
      />
      <Card>
        <Loaded q={q}>
          {(rows) => (
            <Table head={["Customer", "Interest", "Next follow-up", "Last contact", "Owner", ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={6} text="Nothing due. Well done." />
              ) : (
                rows.flatMap((r) => {
                  const due = r.next_followup_at ? new Date(r.next_followup_at).getTime() : null;
                  return [
                    <tr key={r.enquiry_id}>
                      <Td>
                        <span className="font-medium">{r.customer_name}</span>
                        <div className="text-xs text-slate-500">
                          <a href={`tel:${r.mobile}`} className="hover:underline">
                            {r.mobile}
                          </a>
                          {" · "}
                          <a href={`https://wa.me/91${r.mobile}`} target="_blank" rel="noreferrer" className="hover:underline">
                            WhatsApp
                          </a>
                        </div>
                      </Td>
                      <Td>
                        {r.model ?? "—"} <Chip tone={tempTone(r.temperature)}>{label(TEMPS, r.temperature)}</Chip>
                        <div className="text-xs text-slate-500">{[r.stage, r.source].filter(Boolean).join(" · ")}</div>
                      </Td>
                      <Td>
                        <span className={due && due < now ? "font-medium text-red-700" : ""}>{fmtDateTime(r.next_followup_at)}</span>
                      </Td>
                      <Td muted>
                        {r.last_outcome ? label(OUTCOMES, r.last_outcome) : "Never"}
                        {r.last_note && <div className="max-w-xs truncate text-xs">{r.last_note}</div>}
                        <div className="text-xs">{r.followups} logged</div>
                      </Td>
                      <Td muted>{r.assigned_to}</Td>
                      <Td>
                        <button type="button" onClick={() => setOpen(open === r.enquiry_id ? null : r.enquiry_id)} className="text-xs text-slate-700 underline">
                          {open === r.enquiry_id ? "Close" : "Log contact"}
                        </button>
                      </Td>
                    </tr>,
                    open === r.enquiry_id ? (
                      <tr key={`${r.enquiry_id}-log`}>
                        <td colSpan={6} className="bg-slate-50 px-3 py-3">
                          <LogForm enquiryId={r.enquiry_id} temperature={r.temperature} />
                          <HistoryList enquiryId={r.enquiry_id} />
                        </td>
                      </tr>
                    ) : null,
                  ];
                })
              )}
            </Table>
          )}
        </Loaded>
      </Card>
      <p className="text-xs text-slate-400">
        Need the full enquiry? Open <Link to="/enquiries" className="underline">Enquiries</Link>.
      </p>
    </div>
  );
}

function LogForm({ enquiryId, temperature }: { enquiryId: string; temperature: string }) {
  const tomorrow = new Date(Date.now() + 86_400_000);
  tomorrow.setHours(11, 0, 0, 0);
  return (
    <ActionForm
      label="Save"
      hidden={{}}
      fields={[
        { name: "channel", placeholder: "How", options: CHANNELS, required: true, width: "w-36" },
        { name: "outcome", placeholder: "Outcome", options: OUTCOMES, required: true, width: "w-44" },
        { name: "temperature", placeholder: "Temperature", options: TEMPS, width: "w-28" },
        { name: "next", placeholder: "Next", type: "datetime-local", initial: localDateTime(tomorrow), width: "w-44" },
        { name: "note", placeholder: "What was said", width: "w-72" },
      ]}
      action={async (fd) => {
        const outcome = str(fd, "outcome");
        await rpc("log_followup", {
          p_enquiry_id: enquiryId,
          p_channel: str(fd, "channel"),
          p_outcome: outcome,
          p_note: str(fd, "note"),
          p_next_at: outcome === "not_interested" ? null : toIso(str(fd, "next")),
          p_temperature: str(fd, "temperature") ?? temperature,
        });
      }}
    />
  );
}

function HistoryList({ enquiryId }: { enquiryId: string }) {
  const q = useQuery(() => rpcRows<History>("enquiry_followup_history", { p_enquiry_id: enquiryId }), [enquiryId]);
  if (!q.data?.length) return null;
  return (
    <ul className="mt-3 space-y-1 text-xs text-slate-600">
      {q.data.map((h) => (
        <li key={h.id}>
          <span className="text-slate-400">{fmtDateTime(h.created_at)}</span> · {h.employee} · {label(CHANNELS, h.channel)} ·{" "}
          <span className="font-medium">{label(OUTCOMES, h.outcome)}</span>
          {h.note && <> · {h.note}</>}
        </li>
      ))}
    </ul>
  );
}
