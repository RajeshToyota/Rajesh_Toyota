import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { parseCsv } from "@/lib/csv";
import { supabase } from "@/lib/supabase/client";
import { ActionForm, Card, Chip, EmptyRow, ErrorBox, Loaded, PageHeader, RunButton, Table, Td, fmtDate, fmtDateTime, rpc, rpcRows, str } from "@/ui";

type Hold = {
  booking_id: string;
  customer_name: string | null;
  customer_mobile: string | null;
  ctdms_order_no: string | null;
  outlet: string;
  consultant: string;
  car: string;
  colour: string;
  reason: string;
  held_at: string;
  expected_resume_date: string | null;
  held_by: string | null;
  last_remark: string | null;
  last_remark_at: string | null;
  free_same_colour: number;
  free_other_colours: number;
};

// Techwheels' Hold Customers: everyone on hold with the free cars of their variant, remarks, resume,
// and a bulk hold from a file.
export default function HoldCustomers() {
  const canEdit = useRightGate("hold_customers", "edit");
  const rows = useQuery(() => rpcRows<Hold>("hold_list"), []);
  const [csvRows, setCsvRows] = useState<{ order: string; reason: string }[] | null>(null);
  const [result, setResult] = useState<string | null>(null);

  function exportCsv(list: Hold[]) {
    const head = ["Customer", "Mobile", "CTDMS order", "Branch", "Consultant", "Car", "Colour", "Reason", "On hold since", "Expected back", "Last remark", "Free same colour", "Free other colours"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const body = list.map((h) =>
      [h.customer_name, h.customer_mobile, h.ctdms_order_no, h.outlet, h.consultant, h.car, h.colour, h.reason, h.held_at.slice(0, 10), h.expected_resume_date, h.last_remark, h.free_same_colour, h.free_other_colours]
        .map(esc)
        .join(","),
    );
    const url = URL.createObjectURL(new Blob([[head.join(","), ...body].join("\n")], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "hold-customers.csv";
    a.click();
  }

  return (
    <div>
      <PageHeader
        title="Hold Customers"
        note="A booking on hold has given up its car and is skipped by allotment until resumed. Free cars of the same variant are shown so the customer can be offered one."
        actions={rows.data && <RunButton tone="light" label="Export CSV" run={async () => exportCsv(rows.data!)} />}
      />
      {canEdit && (
        <Card title="Bulk hold" note="CSV with columns: order (CTDMS order no.), reason.">
          <div className="space-y-2 px-3 py-2 text-sm">
            <input
              type="file"
              accept=".csv"
              className="text-xs"
              onChange={(e) =>
                e.target.files?.[0]?.text().then((t) => {
                  const rowsIn = parseCsv(t);
                  const head = rowsIn[0]?.map((h) => h.trim().toLowerCase()) ?? [];
                  setResult(null);
                  setCsvRows(
                    rowsIn
                      .slice(1)
                      .filter((r) => r.some((c) => c.trim()))
                      .map((r) => ({ order: (r[head.indexOf("order")] ?? "").trim(), reason: (r[head.indexOf("reason")] ?? "").trim() })),
                  );
                })
              }
            />
            {result && <p className="text-sm text-slate-700">{result}</p>}
            {csvRows && csvRows.length > 0 && (
              <RunButton
                label={`Put ${csvRows.length} bookings on hold`}
                run={async () => {
                  const errors: string[] = [];
                  let ok = 0;
                  for (const r of csvRows) {
                    const { data } = await supabase.from("bookings").select("id").eq("ctdms_order_booking_no", r.order).neq("status", "cancelled").limit(2);
                    if (!data || data.length !== 1) {
                      errors.push(`${r.order}: ${data?.length ? "more than one booking" : "not found"}`);
                      continue;
                    }
                    try {
                      await rpc("hold_booking", { p_booking_id: data[0].id, p_reason: r.reason || "Bulk hold" }, { refresh: false });
                      ok++;
                    } catch (e) {
                      errors.push(`${r.order}: ${e instanceof Error ? e.message : e}`);
                    }
                  }
                  setResult(`${ok} put on hold.${errors.length ? ` Not done: ${errors.join("; ")}` : ""}`);
                  setCsvRows(null);
                  rows.reload();
                }}
              />
            )}
          </div>
        </Card>
      )}
      <Card>
        {rows.error && <ErrorBox message={rows.error} />}
        <Loaded q={rows}>
          {(list) => (
            <Table head={["Customer", "Car", "On hold", "Free cars", "Remarks", ""]}>
              {list.length === 0 ? (
                <EmptyRow cols={6} text="Nobody is on hold." />
              ) : (
                list.map((h) => (
                  <tr key={h.booking_id}>
                    <Td>
                      <Link to={`/reports/bookings/${h.booking_id}`} className="text-blue-700 hover:underline">
                        {h.customer_name}
                      </Link>
                      <div className="text-xs text-slate-500">
                        {h.customer_mobile} · {h.ctdms_order_no ?? "—"} · {h.consultant}
                      </div>
                    </Td>
                    <Td>
                      {h.car}
                      <div className="text-xs text-slate-500">{h.colour}</div>
                    </Td>
                    <Td>
                      {h.reason}
                      <div className="text-xs text-slate-500">
                        {fmtDate(h.held_at)} by {h.held_by}
                        {h.expected_resume_date && ` · back ${fmtDate(h.expected_resume_date)}`}
                      </div>
                    </Td>
                    <Td>
                      <Chip tone={h.free_same_colour ? "emerald" : "slate"}>{h.free_same_colour} same colour</Chip>{" "}
                      <Chip tone={h.free_other_colours ? "blue" : "slate"}>{h.free_other_colours} other</Chip>
                    </Td>
                    <Td>
                      {h.last_remark && (
                        <div className="text-xs">
                          {h.last_remark} <span className="text-slate-400">{fmtDateTime(h.last_remark_at)}</span>
                        </div>
                      )}
                      <ActionForm
                        tone="light"
                        label="Add"
                        hidden={{}}
                        fields={[{ name: "remark", placeholder: "Remark", required: true, width: "w-40" }]}
                        action={async (fd) => {
                          await rpc("add_hold_remark", { p_booking_id: h.booking_id, p_remark: str(fd, "remark") });
                        }}
                      />
                    </Td>
                    <Td>
                      {canEdit && (
                        <ActionForm
                          label="Resume"
                          hidden={{}}
                          fields={[{ name: "note", placeholder: "Note", width: "w-28" }]}
                          action={async (fd) => {
                            await rpc("resume_booking", { p_booking_id: h.booking_id, p_note: str(fd, "note") });
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
    </div>
  );
}
