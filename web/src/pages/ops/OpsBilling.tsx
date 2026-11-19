import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { can, useRightGate } from "@/lib/rbac";
import { useCurrentEmployee } from "@/lib/auth";
import {
  ActionForm,
  Card,
  Chip,
  EmptyRow,
  Loaded,
  PageHeader,
  RunButton,
  Table,
  Td,
  fmtDate,
  fmtDateTime,
  inr,
  rpc,
  rpcRows,
  str,
} from "@/ui";
import { OutletPicker, STAGES, StageChip, carLine, type StageId, type StageState } from "./shared";

type Row = {
  booking_id: string;
  outlet: string;
  customer_name: string;
  customer_mobile: string | null;
  order_no: string | null;
  consultant: string | null;
  model: string | null;
  variant: string | null;
  color: string | null;
  vin: string | null;
  invoice_no: string | null;
  invoice_date: string | null;
  outstanding: number;
  sent_at: string;
  delivery_slot: string | null;
  stages: Record<StageId, StageState>;
  pending_reversals: number;
};

// Techwheels' Ops Billing: every car sent for billing, stage by stage, until it leaves the yard.
// A tab shows the cars waiting on that desk, with the desk's action on each row.
export default function OpsBilling() {
  const [params, setParams] = useSearchParams();
  const stage = (params.get("stage") ?? "") as StageId | "";
  const [outlet, setOutlet] = useState("");
  const board = useQuery(() => rpcRows<Row>("ops_board", { p_stage: stage || null, p_outlet_id: outlet || null }), [stage, outlet]);
  const counts = useQuery(() => rpcRows<Row>("ops_board", { p_stage: null, p_outlet_id: outlet || null }), [outlet]);
  const canApprove = useRightGate("ops_billing", "approve");
  const me = useCurrentEmployee();

  const pendingCount = (id: StageId) => (counts.data ?? []).filter((r) => r.stages?.[id]?.status === "pending").length;
  const setStage = (s: string) => setParams(s ? { stage: s } : {});

  return (
    <div>
      <PageHeader
        title="Ops Billing"
        note="Cars sent for billing, stage by stage. Stages with a ✓ filled themselves or were marked by their desk; the gate pass needs them all."
        actions={<OutletPicker value={outlet} onChange={setOutlet} />}
      />
      <div className="mb-4 flex flex-wrap gap-1">
        <StageTab active={!stage} onClick={() => setStage("")} label="All" count={counts.data?.length} />
        {STAGES.map((s) => (
          <StageTab key={s.id} active={stage === s.id} onClick={() => setStage(s.id)} label={s.label} count={pendingCount(s.id)} />
        ))}
      </div>

      {canApprove && <Reversals />}
      {me?.roleRank != null && me.roleRank <= 1 && <OpsSettings />}

      <Card title={stage ? `Waiting on ${STAGES.find((s) => s.id === stage)?.label}` : "All cars in ops"}>
        <Loaded q={board}>
          {(rows) => (
            <Table head={["Customer", "Car", "Invoice", "Outstanding", "Stages", stage ? "Action" : "Delivery"]}>
              {rows.length === 0 ? (
                <EmptyRow cols={6} text={stage ? "Nothing waiting on this desk." : "No cars in the ops pipeline."} />
              ) : (
                rows.map((r) => (
                  <tr key={r.booking_id}>
                    <Td>
                      <Link to={`/reports/bookings/${r.booking_id}`} className="font-medium text-slate-900 hover:underline">
                        {r.customer_name}
                      </Link>
                      <div className="text-xs text-slate-500">
                        {[r.order_no, r.customer_mobile, r.consultant, r.outlet].filter(Boolean).join(" · ")}
                      </div>
                    </Td>
                    <Td>
                      {carLine(r)}
                      <div className="font-mono text-xs text-slate-500">{r.vin ?? "—"}</div>
                    </Td>
                    <Td muted>
                      {r.invoice_no ?? "—"}
                      <div className="text-xs">{fmtDate(r.invoice_date)}</div>
                    </Td>
                    <Td right>{Number(r.outstanding) > 0 ? <span className="text-amber-700">{inr(r.outstanding)}</span> : <Chip tone="emerald">Paid</Chip>}</Td>
                    <Td>
                      <div className="flex max-w-md flex-wrap gap-1">
                        {STAGES.map((s) => (
                          <StageChip key={s.id} stage={s.id} state={r.stages?.[s.id]} />
                        ))}
                        {r.pending_reversals > 0 && <Chip tone="red">Reopen asked</Chip>}
                      </div>
                    </Td>
                    <Td>{stage ? <StageAction stage={stage} row={r} /> : <span className="text-xs text-slate-500">{r.delivery_slot ?? "No slot"}</span>}</Td>
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

function StageTab({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-3 py-1 text-sm ${active ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"}`}
    >
      {label}
      {count ? <span className={`ml-1.5 text-xs ${active ? "text-slate-300" : "text-amber-700"}`}>{count}</span> : null}
    </button>
  );
}

// What the desk does from its own tab. Stages that fill themselves link to where they are filled.
function StageAction({ stage, row }: { stage: StageId; row: Row }) {
  const state = row.stages?.[stage];
  const id = row.booking_id;
  const meta = STAGES.find((s) => s.id === stage)!;
  const reopen = (
    <ActionForm
      tone="light"
      label="Ask to reopen"
      hidden={{}}
      fields={[{ name: "reason", placeholder: "Why", required: true, width: "w-36" }]}
      action={async (fd) => {
        await rpc("request_stage_reversal", { p_booking_id: id, p_stage: stage, p_reason: str(fd, "reason") });
      }}
    />
  );
  if (state?.status === "done" || state?.status === "na") {
    return ["accounts", "accessories", "scheme", "scrap", "pdi", "gate_pass"].includes(stage) ? reopen : <span className="text-xs text-slate-400">Done</span>;
  }
  if (meta.manual) {
    if (!can(meta.module, "edit")) return <span className="text-xs text-slate-400">{state?.detail}</span>;
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs text-slate-500">{state?.detail}</span>
        <ActionForm
          label="Mark done"
          hidden={{}}
          fields={[
            { name: "ref", placeholder: stage === "scheme" ? "Claim no." : "Ref (optional)", width: "w-28" },
            { name: "note", placeholder: stage === "accounts" ? "How is the balance covered?" : "Note", required: stage === "accounts", width: "w-48" },
          ]}
          action={async (fd) => {
            await rpc("ops_mark_stage", { p_booking_id: id, p_stage: stage, p_status: "done", p_note: str(fd, "note"), p_ref_no: str(fd, "ref") });
          }}
        />
        {stage !== "accounts" && (
          <RunButton
            tone="light"
            label="Not needed"
            confirm="Mark this stage as not needed for this booking?"
            run={() => rpc("ops_mark_stage", { p_booking_id: id, p_stage: stage, p_status: "na" })}
          />
        )}
      </div>
    );
  }
  if (stage === "insurance" && can("ops_insurance", "edit")) {
    return (
      <ActionForm
        label="Save policy"
        hidden={{}}
        fields={[
          { name: "insurer", placeholder: "Insurer", width: "w-28" },
          { name: "policy", placeholder: "Policy no.", required: true, width: "w-32" },
        ]}
        action={async (fd) => {
          await rpc("save_insurance_policy", { p_booking_id: id, p: { insurer_name: str(fd, "insurer"), policy_no: str(fd, "policy") } });
        }}
      />
    );
  }
  if (stage === "rto" && can("ops_rto", "edit")) {
    return (
      <ActionForm
        label="Save"
        hidden={{}}
        fields={[{ name: "reg", placeholder: "Temp. reg. no.", required: true, width: "w-36" }]}
        action={async (fd) => {
          await rpc("save_rto_registration", { p_booking_id: id, p: { temp_reg_no: str(fd, "reg") } });
        }}
      />
    );
  }
  if (stage === "gate_pass" && state?.status === "pending" && can("gate_pass", "create")) {
    return <RunButton label="Issue gate pass" run={() => rpc("issue_gate_pass", { p_booking_id: id })} />;
  }
  if (stage === "pdi") return <Link to="/pdi-board" className="text-xs text-slate-700 underline">PDI board</Link>;
  if (stage === "billing") return <Link to="/ops-billing/crm-billing/invoices" className="text-xs text-slate-700 underline">Billing desk</Link>;
  return <span className="text-xs text-slate-400">{state?.detail}</span>;
}

type Reversal = { id: string; booking_id: string; customer_name: string; stage: string; reason: string; requested_by: string; requested_at: string };

function Reversals() {
  const q = useQuery(() => rpcRows<Reversal>("ops_reversal_requests"), []);
  if (!q.data?.length) return null;
  return (
    <Card title={`Requests to reopen a stage (${q.data.length})`} note="Approving reopens the stage and cancels the gate pass if one was issued.">
      <Table head={["Customer", "Stage", "Reason", "Asked by", ""]}>
        {q.data.map((r) => (
          <tr key={r.id}>
            <Td>{r.customer_name}</Td>
            <Td>{STAGES.find((s) => s.id === r.stage)?.label ?? r.stage}</Td>
            <Td>{r.reason}</Td>
            <Td muted>
              {r.requested_by}
              <div className="text-xs">{fmtDateTime(r.requested_at)}</div>
            </Td>
            <Td>
              <div className="flex gap-1">
                <RunButton label="Approve" run={() => rpc("decide_stage_reversal", { p_reversal_id: r.id, p_approve: true })} />
                <RunButton tone="danger" label="Reject" run={() => rpc("decide_stage_reversal", { p_reversal_id: r.id, p_approve: false })} />
              </div>
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

type OpsConfig = { enabled: boolean; slot_times: string[]; slot_capacity: number };

function OpsSettings() {
  const q = useQuery(async () => must(await supabase.from("ops_config").select("enabled, slot_times, slot_capacity").single()) as OpsConfig, []);
  if (!q.data) return null;
  const c = q.data;
  return (
    <Card
      title="Ops settings"
      note={
        c.enabled
          ? "On: a car can only be delivered once its gate pass is issued."
          : "Off: the boards can be used, but delivery does not wait for the gate pass yet."
      }
      aside={
        <RunButton
          tone={c.enabled ? "danger" : "dark"}
          label={c.enabled ? "Switch off" : "Switch on"}
          confirm={c.enabled ? "Stop requiring the gate pass for delivery?" : "Require the gate pass (and every ops stage) before delivery?"}
          run={() => rpc("ops_config_update", { p_enabled: !c.enabled })}
        />
      }
    >
      <div className="px-3 py-2">
        <ActionForm
          label="Save slots"
          hidden={{}}
          fields={[
            { name: "times", placeholder: "Slot times", initial: c.slot_times.join(", "), width: "w-72" },
            { name: "cap", placeholder: "Cars per slot", type: "number", initial: String(c.slot_capacity), width: "w-28" },
          ]}
          action={async (fd) => {
            const times = (str(fd, "times") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
            await rpc("ops_config_update", { p_enabled: c.enabled, p_slot_times: times, p_slot_capacity: Number(str(fd, "cap")) });
          }}
        />
      </div>
    </Card>
  );
}
