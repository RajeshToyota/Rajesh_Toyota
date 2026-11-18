import { useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase/client";
import { useQuery } from "@/lib/query";
import { can, useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, ErrorBox, Loaded, PageHeader, RunButton, Table, Tabs, Td, fmtDateTime, inputCls, inr, rpc, rpcRows, str } from "@/ui";

type Ev = {
  id: string;
  outlet: string;
  customer_name: string;
  customer_mobile: string | null;
  reg_no: string;
  car: string;
  mfg_year: number | null;
  odometer_km: number | null;
  owners: number | null;
  status: string;
  customer_expected: number | null;
  evaluator_price: number | null;
  last_dealer_offer: number | null;
  last_customer_ask: number | null;
  final_price: number | null;
  utrust: boolean;
  requested_by: string | null;
  evaluator: string | null;
  requested_at: string;
  booking_id: string | null;
  photos: number;
  condition: Record<string, number>;
  remarks: string | null;
};
type Neg = { created_at: string; side: string; amount: number; note: string | null; by_name: string | null };

const tone: Record<string, "amber" | "blue" | "emerald" | "slate" | "red"> = {
  requested: "amber",
  evaluated: "blue",
  negotiating: "blue",
  accepted: "emerald",
  procured: "emerald",
  rejected: "red",
  cancelled: "slate",
};

// Techwheels' exchange business for Toyota U Trust: request, inspect and value, negotiate, buy in.
export default function Evaluations() {
  const [status, setStatus] = useState("open");
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery(() => rpcRows<Ev>("used_car_evaluation_list", { p_status: status === "all" ? null : status }), [status]);
  const canRequest = useRightGate("used_car_evaluations", "create");

  return (
    <div>
      <PageHeader title="Exchange Evaluations" note="The customer's old car: valued by the branch evaluator, negotiated, and bought in against the new booking." />
      {canRequest && <RequestForm />}
      <Tabs
        current={status}
        onChange={setStatus}
        tabs={[
          { id: "open", label: "Open" },
          { id: "requested", label: "To inspect" },
          { id: "procured", label: "Bought in" },
          { id: "all", label: "All" },
        ]}
      />
      <Card>
        <Loaded q={q}>
          {(rows) => (
            <Table head={["Car", "Customer", "Asked / valued / offered", "Status", ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={5} text="No evaluations." />
              ) : (
                rows.flatMap((e) => [
                  <tr key={e.id}>
                    <Td>
                      <span className="font-mono text-xs">{e.reg_no}</span> {e.utrust && <Chip tone="emerald">U Trust</Chip>}
                      <div>{e.car}</div>
                      <div className="text-xs text-slate-500">{[e.mfg_year, e.odometer_km != null && `${e.odometer_km.toLocaleString("en-IN")} km`, e.owners && `${e.owners} owner`].filter(Boolean).join(" · ")}</div>
                    </Td>
                    <Td>
                      {e.booking_id ? (
                        <Link to={`/reports/bookings/${e.booking_id}`} className="hover:underline">
                          {e.customer_name}
                        </Link>
                      ) : (
                        e.customer_name
                      )}
                      <div className="text-xs text-slate-500">{[e.customer_mobile, e.requested_by, e.outlet].filter(Boolean).join(" · ")}</div>
                    </Td>
                    <Td>
                      <div className="text-xs">
                        Asks {inr(e.last_customer_ask ?? e.customer_expected)} · valued {inr(e.evaluator_price)} · offered {inr(e.last_dealer_offer)}
                      </div>
                      {e.final_price != null && <div className="font-medium">Agreed {inr(e.final_price)}</div>}
                    </Td>
                    <Td>
                      <Chip tone={tone[e.status]}>{e.status}</Chip>
                      {e.evaluator && <div className="text-xs text-slate-500">{e.evaluator}</div>}
                    </Td>
                    <Td>
                      <button type="button" onClick={() => setOpen(open === e.id ? null : e.id)} className="text-xs underline">
                        {open === e.id ? "Close" : "Open"}
                      </button>
                    </Td>
                  </tr>,
                  open === e.id ? (
                    <tr key={`${e.id}-detail`}>
                      <td colSpan={5} className="bg-slate-50 px-3 py-3">
                        <Detail ev={e} />
                      </td>
                    </tr>
                  ) : null,
                ])
              )}
            </Table>
          )}
        </Loaded>
      </Card>
    </div>
  );
}

function RequestForm() {
  return (
    <Card title="Ask for an evaluation" note="Linking the booking (or enquiry) puts the agreed value on it as an exchange receipt when the car is bought.">
      <div className="px-3 py-2">
        <ActionForm
          label="Request"
          hidden={{}}
          fields={[
            { name: "reg_no", placeholder: "Reg. no.", required: true, width: "w-32" },
            { name: "make", placeholder: "Make (Toyota)", width: "w-28" },
            { name: "model", placeholder: "Model", required: true, width: "w-32" },
            { name: "mfg_year", placeholder: "Year", type: "number", width: "w-20" },
            { name: "odometer_km", placeholder: "Km", type: "number", width: "w-24" },
            { name: "customer_expected", placeholder: "Customer asks ₹", type: "number", width: "w-32" },
            { name: "customer_name", placeholder: "Customer (if no booking)", width: "w-44" },
            { name: "customer_mobile", placeholder: "Mobile", width: "w-28" },
            { name: "booking_id", placeholder: "Booking ID (optional)", width: "w-64" },
          ]}
          action={async (fd) => {
            const p = Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]));
            await rpc("request_evaluation", { p });
          }}
        />
      </div>
    </Card>
  );
}

function Detail({ ev }: { ev: Ev }) {
  const neg = useQuery(() => rpcRows<Neg>("used_car_negotiation_log", { p_id: ev.id }), [ev.id]);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const isEvaluator = can("used_car_evaluations", "edit");
  const openish = ["requested", "evaluated", "negotiating"].includes(ev.status);

  return (
    <div className="space-y-3">
      {error && <ErrorBox message={error} />}
      {isEvaluator && openish && (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Inspection and valuation</p>
          <input type="file" accept="image/*" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} className="mb-2 text-sm" />
          <span className="ml-2 text-xs text-slate-500">{ev.photos} photo(s) saved; at least 4 needed.</span>
          <ActionForm
            label="Save valuation"
            hidden={{}}
            fields={[
              { name: "evaluator_price", placeholder: "Value ₹", type: "number", required: true, width: "w-28" },
              { name: "engine", placeholder: "Engine 1-5", type: "number", width: "w-24" },
              { name: "body", placeholder: "Body 1-5", type: "number", width: "w-24" },
              { name: "interior", placeholder: "Interior 1-5", type: "number", width: "w-24" },
              { name: "tyres", placeholder: "Tyres 1-5", type: "number", width: "w-24" },
              { name: "accident_history", placeholder: "Accident history", width: "w-40" },
              { name: "hypothecated_to", placeholder: "Loan with", width: "w-28" },
              { name: "remarks", placeholder: "Remarks", width: "w-48" },
            ]}
            action={async (fd) => {
              setError(null);
              const paths: string[] = [];
              for (const f of files) {
                const path = `used-car/${ev.id}/${Date.now()}-${f.name.replace(/[^\w.-]/g, "_")}`;
                const { error: upErr } = await supabase.storage.from("used-car-photos").upload(path, f);
                if (upErr) throw new Error(upErr.message);
                paths.push(path);
              }
              const condition = Object.fromEntries(["engine", "body", "interior", "tyres"].filter((k) => str(fd, k)).map((k) => [k, Number(str(fd, k))]));
              await rpc("record_evaluation", {
                p_id: ev.id,
                p: {
                  evaluator_price: Number(str(fd, "evaluator_price")),
                  condition: Object.keys(condition).length ? condition : undefined,
                  accident_history: str(fd, "accident_history"),
                  hypothecated_to: str(fd, "hypothecated_to"),
                  remarks: str(fd, "remarks"),
                  photo_paths: paths.length ? paths : undefined,
                },
              });
              setFiles([]);
            }}
          />
        </div>
      )}
      {(ev.status === "evaluated" || ev.status === "negotiating") && (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Negotiation</p>
          <ul className="mb-2 space-y-0.5 text-xs text-slate-600">
            {(neg.data ?? []).map((n, i) => (
              <li key={i}>
                {fmtDateTime(n.created_at)} · {n.side === "dealer" ? "We offered" : "Customer asked"} <span className="font-medium">{inr(n.amount)}</span>
                {n.note && ` · ${n.note}`} · {n.by_name}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-start gap-2">
            <ActionForm
              label="Log"
              hidden={{}}
              fields={[
                { name: "side", placeholder: "Who", options: [{ id: "dealer", name: "Our offer" }, { id: "customer", name: "Customer asks" }], required: true, width: "w-32" },
                { name: "amount", placeholder: "₹", type: "number", required: true, width: "w-28" },
                { name: "note", placeholder: "Note", width: "w-40" },
              ]}
              action={async (fd) => {
                await rpc("log_used_car_offer", { p_id: ev.id, p_side: str(fd, "side"), p_amount: Number(str(fd, "amount")), p_note: str(fd, "note") });
              }}
            />
            <ActionForm
              label="Customer accepts"
              hidden={{}}
              fields={[{ name: "price", placeholder: "Final ₹ (blank: our last offer)", type: "number", width: "w-56" }]}
              action={async (fd) => {
                await rpc("accept_used_car_offer", { p_id: ev.id, p_final_price: str(fd, "price") ? Number(str(fd, "price")) : null });
              }}
            />
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {ev.status === "accepted" && can("used_car_stock", "create") && (
          <ActionForm
            label={`Buy in for ${inr(ev.final_price)}`}
            hidden={{}}
            fields={[{ name: "notes", placeholder: "RC, NOC, keys collected…", width: "w-64" }]}
            action={async (fd) => {
              await rpc("procure_used_car", { p_id: ev.id, p_notes: str(fd, "notes") });
            }}
          />
        )}
        {!["procured", "rejected", "cancelled"].includes(ev.status) && (
          <ActionForm
            tone="danger"
            label="Close"
            hidden={{}}
            fields={[
              { name: "status", placeholder: "Why closed", options: [{ id: "rejected", name: "Customer declined" }, { id: "cancelled", name: "Cancelled" }], required: true, width: "w-40" },
              { name: "reason", placeholder: "Reason", required: true, width: "w-48" },
            ]}
            action={async (fd) => {
              await rpc("close_evaluation", { p_id: ev.id, p_status: str(fd, "status"), p_reason: str(fd, "reason") });
            }}
          />
        )}
        {ev.remarks && <span className="text-xs text-slate-500">Remarks: {ev.remarks}</span>}
      </div>
      <Photos id={ev.id} count={ev.photos} />
    </div>
  );
}

function Photos({ id, count }: { id: string; count: number }) {
  const [urls, setUrls] = useState<string[] | null>(null);
  if (!count) return null;
  if (!urls) {
    return (
      <RunButton
        tone="light"
        label={`Show ${count} photo(s)`}
        run={async () => {
          const { data } = await supabase.storage.from("used-car-photos").list(`used-car/${id}`);
          const paths = (data ?? []).map((f) => `used-car/${id}/${f.name}`);
          const { data: signed } = await supabase.storage.from("used-car-photos").createSignedUrls(paths, 600);
          setUrls((signed ?? []).map((s) => s.signedUrl).filter(Boolean) as string[]);
        }}
      />
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      {urls.map((u) => (
        <a key={u} href={u} target="_blank" rel="noreferrer">
          <img src={u} alt="" className={`h-24 w-32 rounded object-cover ${inputCls}`} />
        </a>
      ))}
    </div>
  );
}
