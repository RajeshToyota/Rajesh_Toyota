import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { Card, Chip, EmptyRow, Loaded, PageHeader, RunButton, Table, Tabs, Td, fmtDateTime, inputCls, inr, rpc, rpcRows, titleCase } from "@/ui";
import QuoteBuilder from "./QuoteBuilder";

export type WorkbenchRow = {
  quote_id: string;
  created_at: string;
  customer_name: string;
  customer_mobile: string | null;
  consultant: string;
  outlet: string;
  car: string;
  colour: string;
  stage: string;
  stage_state: string;
  total_amount: number | null;
  quantity: number;
  bookings: number;
  booking_ids: string[];
  pending_approval_id: string | null;
  required_role: string | null;
  requested_amount: number | null;
  billed: boolean;
  source: string;
};

export const STAGE_LABEL: Record<string, string> = {
  basic: "Basic",
  with_schemes: "Schemes",
  with_dealer_discount: "Dealer discount",
  final: "Final",
};

// Techwheels' Manage Quotes: create, approve, proceed to booking and follow the bookings, over
// Rajesh Toyota's staged quotes (Basic → schemes → dealer discount → final).
export default function Quotes() {
  const canCreate = useRightGate("quotes", "create");
  const [tab, setTab] = useState("drafts");
  const [search, setSearch] = useState("");
  const rows = useQuery(() => (tab === "create" ? Promise.resolve([] as WorkbenchRow[]) : rpcRows<WorkbenchRow>("quote_workbench", { p_tab: tab, p_search: search || null })), [tab, search]);

  return (
    <div>
      <PageHeader
        title="Quotes"
        note="A quote moves Basic → company schemes (Team Leader) → dealer discount (Outlet Head / Business Head) → final, then to booking. Below the margin floor the Business Head approves."
        actions={tab !== "create" && <input className={inputCls} placeholder="Customer or mobile" value={search} onChange={(e) => setSearch(e.target.value)} />}
      />
      <Tabs
        current={tab}
        onChange={setTab}
        tabs={[
          ...(canCreate ? [{ id: "create", label: "Create" }] : []),
          { id: "drafts", label: "In progress" },
          { id: "approve", label: "Approve" },
          { id: "proceed", label: "Proceed to booking" },
          { id: "bookings", label: "Bookings" },
        ]}
      />
      {tab === "create" ? (
        <QuoteBuilder onSaved={() => setTab("drafts")} />
      ) : (
        <Card>
          <Loaded q={rows}>
            {(list) => (
              <Table head={["Quote", "Customer", "Car", "Stage", "Total", tab === "approve" ? "Approval" : "Cars / bookings", ""]}>
                {list.length === 0 ? (
                  <EmptyRow cols={7} text="Nothing here." />
                ) : (
                  list.map((r) => (
                    <tr key={r.quote_id}>
                      <Td muted>
                        {fmtDateTime(r.created_at)}
                        <div className="text-xs">
                          {r.consultant} · {r.outlet}
                        </div>
                      </Td>
                      <Td>
                        {r.customer_name}
                        <div className="text-xs text-slate-500">{r.customer_mobile}</div>
                      </Td>
                      <Td>
                        {r.car}
                        <div className="text-xs text-slate-500">{r.colour}</div>
                      </Td>
                      <Td>
                        <Chip tone={r.stage === "final" ? "emerald" : r.stage_state === "pending" ? "amber" : r.stage_state === "rejected" ? "red" : "slate"}>
                          {STAGE_LABEL[r.stage] ?? r.stage}
                          {r.stage !== "final" && r.stage_state !== "cleared" ? ` · ${r.stage_state}` : ""}
                        </Chip>
                        {r.billed && (
                          <div className="mt-1">
                            <Chip tone="blue">Invoiced</Chip>
                          </div>
                        )}
                      </Td>
                      <Td right>{inr(r.total_amount)}</Td>
                      <Td>
                        {tab === "approve" ? (
                          <ApprovalCell row={r} />
                        ) : (
                          <span className="text-sm">
                            {r.quantity > 1 ? `${r.bookings} of ${r.quantity} booked` : r.bookings ? "Booked" : "—"}
                          </span>
                        )}
                      </Td>
                      <Td>
                        <Link to={`/quotes/${r.quote_id}`} className="text-sm text-blue-700 hover:underline">
                          Open
                        </Link>
                      </Td>
                    </tr>
                  ))
                )}
              </Table>
            )}
          </Loaded>
        </Card>
      )}
    </div>
  );
}

function ApprovalCell({ row }: { row: WorkbenchRow }) {
  if (!row.pending_approval_id) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs text-slate-600">
        {row.required_role} · {inr(row.requested_amount)}
      </p>
      <div className="flex gap-1">
        <RunButton label="Approve" run={() => rpc("decide_approval", { p_approval_id: row.pending_approval_id, p_decision: "approved" })} />
        <RunButton
          tone="danger"
          label="Reject"
          run={async () => {
            const reason = window.prompt("Reason for rejecting?");
            if (!reason) return;
            await rpc("decide_approval", { p_approval_id: row.pending_approval_id, p_decision: "rejected", p_comment: reason });
          }}
        />
      </div>
    </div>
  );
}

export const stageTitle = (s: string) => STAGE_LABEL[s] ?? titleCase(s);
