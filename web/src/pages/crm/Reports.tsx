import { useState } from "react";
import { useQuery } from "@/lib/query";
import { Card, EmptyRow, Loaded, PageHeader, Table, Td, inputCls, rpcRows, todayIst } from "@/ui";

function useRange() {
  const today = todayIst();
  const [from, setFrom] = useState(today.slice(0, 8) + "01");
  const [to, setTo] = useState(today);
  const picker = (
    <>
      <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
      <span className="text-slate-400">to</span>
      <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
    </>
  );
  return { from, to, picker };
}

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "—");

type Walk = { outlet: string; walkins: number; visitors: number; attended: number; converted: number; left_unattended: number; booked: number; avg_wait_min: number | null };

export function WalkinReport() {
  const { from, to, picker } = useRange();
  const q = useQuery(() => rpcRows<Walk>("walkin_conversion", { p_from: from, p_to: to }), [from, to]);
  return (
    <div>
      <PageHeader title="Walk-in Conversion" note="Showroom walk-ins from the reception register: how many became enquiries, and bookings." actions={picker} />
      <Card>
        <Loaded q={q}>
          {(rows) => (
            <Table head={["Branch", "Walk-ins", "People", "Attended", "Enquiries", "Booked", "Left", "Avg. wait"]}>
              {rows.length === 0 ? (
                <EmptyRow cols={8} text="No walk-ins in this period." />
              ) : (
                rows.map((r) => (
                  <tr key={r.outlet}>
                    <Td>{r.outlet}</Td>
                    <Td right>{r.walkins}</Td>
                    <Td right>{r.visitors}</Td>
                    <Td right>{r.attended}</Td>
                    <Td right>
                      {r.converted} <span className="text-xs text-slate-400">{pct(r.converted, r.walkins)}</span>
                    </Td>
                    <Td right>
                      {r.booked} <span className="text-xs text-slate-400">{pct(r.booked, r.walkins)}</span>
                    </Td>
                    <Td right>{r.left_unattended}</Td>
                    <Td right>{r.avg_wait_min != null ? `${r.avg_wait_min} min` : "—"}</Td>
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

type Comp = { employee_id: string; employee: string; outlet: string | null; logged: number; on_time: number; late: number; overdue_now: number; open_enquiries: number };

export function FollowupReport() {
  const { from, to, picker } = useRange();
  const q = useQuery(() => rpcRows<Comp>("followup_compliance", { p_from: from, p_to: to }), [from, to]);
  return (
    <div>
      <PageHeader title="Follow-up Compliance" note="Follow-ups logged by each consultant, how many were on time, and open enquiries overdue right now." actions={picker} />
      <Card>
        <Loaded q={q}>
          {(rows) => (
            <Table head={["Consultant", "Branch", "Logged", "On time", "Late", "Overdue now", "Open enquiries"]}>
              {rows.length === 0 ? (
                <EmptyRow cols={7} text="No consultants with enquiries in your view." />
              ) : (
                rows.map((r) => (
                  <tr key={r.employee_id}>
                    <Td>{r.employee}</Td>
                    <Td muted>{r.outlet ?? "—"}</Td>
                    <Td right>{r.logged}</Td>
                    <Td right>
                      {r.on_time} <span className="text-xs text-slate-400">{pct(r.on_time, r.logged)}</span>
                    </Td>
                    <Td right>{r.late}</Td>
                    <Td right className={r.overdue_now ? "font-medium text-red-700" : ""}>
                      {r.overdue_now}
                    </Td>
                    <Td right>{r.open_enquiries}</Td>
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
