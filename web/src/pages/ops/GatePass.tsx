import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, Table, Td, fmtDateTime, inputCls, rpc, rpcRows, str } from "@/ui";
import { carLine } from "./shared";

type Pass = {
  id: string;
  gate_pass_no: string;
  booking_id: string;
  outlet: string;
  customer_name: string;
  model: string | null;
  variant: string | null;
  color: string | null;
  vin: string;
  issued_at: string;
  issued_by: string | null;
  delivered: boolean;
  exited_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
};

// The security desk: gate passes issued, and recording each car as it leaves after the handover.
export default function GatePass() {
  const [since, setSince] = useState(() => new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
  const q = useQuery(() => rpcRows<Pass>("gate_pass_list", { p_since: since }), [since]);
  const canExit = useRightGate("gate_pass", "edit");

  return (
    <div>
      <PageHeader
        title="Gate Pass"
        note="A car leaves the yard only with a valid gate pass, after it has been handed over."
        actions={
          <label className="flex items-center gap-2 text-sm text-slate-500">
            Since <input type="date" value={since} onChange={(e) => setSince(e.target.value)} className={inputCls} />
          </label>
        }
      />
      {canExit && (
        <Card title="Record a car leaving">
          <div className="px-3 py-2">
            <ActionForm
              label="Let it out"
              hidden={{}}
              fields={[{ name: "no", placeholder: "Gate pass number, e.g. GP/JP05A/2611/0001", required: true, width: "w-80" }]}
              action={async (fd) => {
                await rpc("record_gate_exit", { p_gate_pass_no: str(fd, "no") });
              }}
            />
          </div>
        </Card>
      )}
      <Card title="Gate passes">
        <Loaded q={q}>
          {(rows) => (
            <Table head={["Gate pass", "Customer", "Car", "Issued", "Status"]}>
              {rows.length === 0 ? (
                <EmptyRow cols={5} text="No gate passes in this period." />
              ) : (
                rows.map((g) => (
                  <tr key={g.id} className={g.voided_at ? "opacity-50" : ""}>
                    <Td>
                      <span className="font-mono">{g.gate_pass_no}</span>
                    </Td>
                    <Td>
                      <Link to={`/reports/bookings/${g.booking_id}`} className="hover:underline">
                        {g.customer_name}
                      </Link>
                      <div className="text-xs text-slate-500">{g.outlet}</div>
                    </Td>
                    <Td>
                      {carLine(g)}
                      <div className="font-mono text-xs text-slate-500">{g.vin}</div>
                    </Td>
                    <Td muted>
                      {fmtDateTime(g.issued_at)}
                      <div className="text-xs">{g.issued_by}</div>
                    </Td>
                    <Td>
                      {g.voided_at ? (
                        <Chip>Cancelled: {g.void_reason}</Chip>
                      ) : g.exited_at ? (
                        <Chip tone="emerald">Left {fmtDateTime(g.exited_at)}</Chip>
                      ) : g.delivered ? (
                        <Chip tone="blue">Handed over, at the gate</Chip>
                      ) : (
                        <Chip tone="amber">Waiting for handover</Chip>
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
