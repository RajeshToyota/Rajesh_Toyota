import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { Card, Chip, EmptyRow, Loaded, PageHeader, RunButton, Select, Table, Td, fmtDateTime, inputCls, rpc, rpcRows } from "@/ui";

type BoardRow = { booking_id: string; customer_name: string; customer_mobile: string | null; ctdms_order_no: string | null; outlet: string; consultant: string; status: string; groups: number; complete: number; pending_review: number };
type Group = { grp: string; label: string; needed: number | null; have: number | null; complete: boolean; doc_types: string[]; missing: string[] };
type Doc = { id: string; doc_type: string; storage_path: string; status: string; rejection_reason: string | null; provided_by: string; uploaded_at: string; employees: { name: string } | null };
type DocType = { code: string; label: string; grp: string };

// Techwheels' Booking Docs: every document a booking needs, in groups whose rules follow the deal
// (company purchase, exchange, finance, BH registration, schemes, invoicing).
export default function BookingDocs() {
  const [search, setSearch] = useState("");
  const [pendingOnly, setPendingOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const board = useQuery(() => rpcRows<BoardRow>("booking_docs_board", { p_search: search || null, p_only_pending: pendingOnly }), [search, pendingOnly]);

  return (
    <div>
      <PageHeader
        title="Booking Docs"
        note="Address proof needs any two; documents from the Welcome Docket and the finance file count too. Uploads by staff with Booking Docs: edit are approved at once."
        actions={
          <>
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={pendingOnly} onChange={(e) => setPendingOnly(e.target.checked)} /> Waiting for review
            </label>
            <input className={inputCls} placeholder="Customer, mobile or order no." value={search} onChange={(e) => setSearch(e.target.value)} />
          </>
        }
      />
      <Card>
        <Loaded q={board}>
          {(rows) => (
            <Table head={["Customer", "Order", "Branch", "Groups", "To review", ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={6} text="No open bookings match." />
              ) : (
                rows.flatMap((r) => [
                  <tr key={r.booking_id}>
                    <Td>
                      {r.customer_name}
                      <div className="text-xs text-slate-500">
                        {r.customer_mobile} · {r.consultant}
                      </div>
                    </Td>
                    <Td muted>{r.ctdms_order_no ?? "—"}</Td>
                    <Td muted>{r.outlet}</Td>
                    <Td>
                      <Chip tone={r.complete === r.groups ? "emerald" : "amber"}>
                        {r.complete}/{r.groups}
                      </Chip>
                    </Td>
                    <Td>{r.pending_review > 0 ? <Chip tone="blue">{r.pending_review}</Chip> : ""}</Td>
                    <Td>
                      <button type="button" className="text-sm text-blue-700 hover:underline" onClick={() => setOpen(open === r.booking_id ? null : r.booking_id)}>
                        {open === r.booking_id ? "Close" : "Documents"}
                      </button>
                    </Td>
                  </tr>,
                  open === r.booking_id && (
                    <tr key={`${r.booking_id}-docs`}>
                      <td colSpan={6} className="bg-slate-50 px-3 py-3">
                        <BookingFile bookingId={r.booking_id} />
                      </td>
                    </tr>
                  ),
                ])
              )}
            </Table>
          )}
        </Loaded>
      </Card>
    </div>
  );
}

export function BookingFile({ bookingId }: { bookingId: string }) {
  const canReview = useRightGate("booking_docs", "approve");
  const canRemove = useRightGate("booking_docs", "edit");
  const data = useQuery(async () => {
    const [groups, docs, types] = await Promise.all([
      rpcRows<Group>("required_doc_groups", { p_booking_id: bookingId }),
      supabase
        .from("booking_documents")
        .select("id, doc_type, storage_path, status, rejection_reason, provided_by, uploaded_at, employees!booking_documents_uploaded_by_fkey(name)")
        .eq("booking_id", bookingId)
        .order("uploaded_at", { ascending: false }),
      supabase.from("booking_document_types").select("code, label, grp").eq("is_active", true).order("sort_order"),
    ]);
    return { groups, docs: must(docs) as unknown as Doc[], types: must(types) as DocType[] };
  }, [bookingId]);
  const [docType, setDocType] = useState("");

  return (
    <Loaded q={data}>
      {({ groups, docs, types }) => {
        const label = (c: string) => types.find((t) => t.code === c)?.label ?? c;
        return (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {groups.map((g) => (
                <div key={g.grp} className={`rounded border px-2 py-1.5 text-xs ${g.complete ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
                  <p className="font-medium text-slate-800">
                    {g.label} {g.needed != null && `(${g.have}/${g.needed})`}
                  </p>
                  {!g.complete && <p className="text-slate-600">Missing: {g.missing.map(label).join(", ") || "—"}</p>}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={docType} onChange={setDocType} placeholder="Document" options={types.map((t) => ({ id: t.code, name: t.label }))} />
              <input
                type="file"
                accept="image/*,application/pdf"
                multiple
                disabled={!docType}
                className="text-xs"
                onChange={async (e) => {
                  const files = [...(e.target.files ?? [])];
                  try {
                    for (const file of files) {
                      const path = `${bookingId}/docs/${docType}-${Date.now()}-${file.name.replace(/[^\w.-]+/g, "_")}`;
                      const up = await supabase.storage.from("booking-documents").upload(path, file);
                      if (up.error) throw new Error(up.error.message);
                      await rpc("add_booking_document", { p_booking_id: bookingId, p_doc_type: docType, p_storage_path: path }, { refresh: false });
                    }
                    data.reload();
                  } catch (err) {
                    alert(err instanceof Error ? err.message : String(err));
                  }
                  e.target.value = "";
                }}
              />
            </div>
            <Table head={["Document", "Status", "Uploaded", ""]}>
              {docs.length === 0 ? (
                <EmptyRow cols={4} text="No documents uploaded here yet (docket and finance documents are counted from their own pages)." />
              ) : (
                docs.map((d) => (
                  <tr key={d.id}>
                    <Td>
                      <button
                        type="button"
                        className="text-blue-700 hover:underline"
                        onClick={async () => {
                          const { data: s } = await supabase.storage.from("booking-documents").createSignedUrl(d.storage_path, 600);
                          if (s?.signedUrl) window.open(s.signedUrl, "_blank");
                        }}
                      >
                        {label(d.doc_type)}
                      </button>
                    </Td>
                    <Td>
                      <Chip tone={d.status === "approved" ? "emerald" : d.status === "rejected" ? "red" : "blue"}>{d.status}</Chip>
                      {d.rejection_reason && <div className="text-xs text-red-600">{d.rejection_reason}</div>}
                    </Td>
                    <Td muted>
                      {fmtDateTime(d.uploaded_at)}
                      <div className="text-xs">{d.employees?.name ?? d.provided_by}</div>
                    </Td>
                    <Td>
                      <div className="flex gap-1">
                        {canReview && d.status === "pending" && (
                          <>
                            <RunButton label="Approve" run={async () => { await rpc("review_booking_document", { p_document_id: d.id, p_approve: true }); data.reload(); }} />
                            <RunButton
                              tone="danger"
                              label="Reject"
                              run={async () => {
                                const reason = window.prompt("Why is it rejected?");
                                if (!reason) return;
                                await rpc("review_booking_document", { p_document_id: d.id, p_approve: false, p_reason: reason });
                                data.reload();
                              }}
                            />
                          </>
                        )}
                        {canRemove && (
                          <RunButton
                            tone="light"
                            label="Remove"
                            run={async () => {
                              const reason = window.prompt("Why remove it?");
                              if (!reason) return;
                              const path = await rpc<string>("remove_booking_document", { p_document_id: d.id, p_reason: reason });
                              await supabase.storage.from("booking-documents").remove([path]);
                              data.reload();
                            }}
                          />
                        )}
                      </div>
                    </Td>
                  </tr>
                ))
              )}
            </Table>
          </div>
        );
      }}
    </Loaded>
  );
}
