import { useQuery } from "@/lib/query";
import { Card, Chip, EmptyRow, Loaded, PageHeader, Stat, Table, Td, inr, rpcRows } from "@/ui";
import { HELD, KINDS, monthLabel } from "./shared";

type Line = { month: string; status: string; kind: string; gross: number; eligible: boolean; ineligible_reason: string | null; release_now: number; held: number; held_until: string | null; held_released_at: string | null; basis: Record<string, unknown> };

export default function MyIncentive() {
  const q = useQuery(() => rpcRows<Line>("my_incentive", { p_months: 12 }), []);
  return (
    <div>
      <PageHeader title="My Incentive" note="What you have earned each month, what is paid with salary and what is held for TKM's settlement or the bank." />
      <Loaded q={q}>
        {(rows) => {
          const heldOpen = rows.filter((r) => r.held > 0 && !r.held_released_at && r.status === "approved").reduce((a, r) => a + Number(r.held), 0);
          const last = rows[0];
          return (
            <>
              <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-3">
                <Stat label={last ? monthLabel(last.month) : "This month"} value={inr(last?.release_now ?? 0)} note={last ? `${last.status}${last.eligible ? "" : " · not eligible"}` : "Not calculated yet"} />
                <Stat label="Held, still to come" value={inr(heldOpen)} />
                <Stat label="Cars (last month)" value={String(last?.basis?.units ?? "—")} />
              </div>
              <Card>
                <Table head={["Month", "Scheme", "Gross", "With salary", "Held", "Status"]}>
                  {rows.length === 0 ? (
                    <EmptyRow cols={6} text="No incentive calculated for you yet." />
                  ) : (
                    rows.map((r, i) => (
                      <tr key={i}>
                        <Td>{monthLabel(r.month)}</Td>
                        <Td>
                          {KINDS[r.kind]}
                          {!r.eligible && <div className="text-xs text-amber-800">{r.ineligible_reason}</div>}
                        </Td>
                        <Td right>{inr(r.gross)}</Td>
                        <Td right>{inr(r.release_now)}</Td>
                        <Td right>
                          {inr(r.held)}
                          {r.held_until && <div className="text-xs text-slate-500">{r.held_released_at ? "Released" : HELD[r.held_until]}</div>}
                        </Td>
                        <Td>
                          <Chip tone={r.status === "approved" ? "emerald" : "amber"}>{r.status}</Chip>
                        </Td>
                      </tr>
                    ))
                  )}
                </Table>
              </Card>
            </>
          );
        }}
      </Loaded>
    </div>
  );
}
