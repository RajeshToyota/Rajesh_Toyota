import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { useCurrentEmployee } from "@/lib/auth";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, RunButton, Select, Table, Tabs, Td, fmtDate, inputCls, rpc, rpcRows, str } from "@/ui";

type Row = {
  id: string;
  direction: "inward" | "outward";
  dealer: string;
  outlet: string;
  vin: string;
  car: string;
  customer_name: string | null;
  transfer_order_no: string | null;
  ctdms_order_no: string | null;
  reason: string;
  status: string;
  requested_at: string;
  dispatched_at: string | null;
  received_at: string | null;
  ctdms_done_at: string | null;
  billed_on: string | null;
  delivered_on: string | null;
};
type Named = { id: string; name: string };

// Techwheels' stock transfers with other Toyota dealers. Outward: the car leaves free stock as soon as
// it is requested. Inward: the car is created on receipt and, when bought in for a customer, allotted
// to them before the pool can hand it to anyone else.
export default function DealerTransfers() {
  const canCreate = useRightGate("dealer_transfers", "create");
  const [tab, setTab] = useState("open");
  const q = useQuery(() => rpcRows<Row>("dealer_transfer_list", { p_open_only: tab === "open" }), [tab]);

  return (
    <div>
      <PageHeader title="Dealer Transfers" note="Requested → approved by the Outlet Head → dispatched / received → CTDMS done." />
      {canCreate && <NewTransfer />}
      <Tabs current={tab} onChange={setTab} tabs={[{ id: "open", label: "Open" }, { id: "all", label: "All" }]} />
      <Card>
        <Loaded q={q}>
          {(rows) => (
            <Table head={["", "Car", "Dealer", "Customer", "Status", "Billed / delivered", ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={7} text="No transfers." />
              ) : (
                rows.map((r) => (
                  <tr key={r.id}>
                    <Td>
                      <Chip tone={r.direction === "inward" ? "emerald" : "amber"}>{r.direction === "inward" ? "In" : "Out"}</Chip>
                    </Td>
                    <Td>
                      <span className="font-mono text-xs">{r.vin}</span>
                      <div>{r.car}</div>
                      <div className="text-xs text-slate-500">
                        {r.outlet}
                        {r.transfer_order_no && ` · TO ${r.transfer_order_no}`}
                      </div>
                    </Td>
                    <Td>
                      {r.dealer}
                      <div className="text-xs text-slate-500">{r.reason}</div>
                    </Td>
                    <Td muted>{r.customer_name ?? "—"}</Td>
                    <Td>
                      <Chip tone={r.status === "ctdms_done" ? "emerald" : r.status === "rejected" || r.status === "cancelled" ? "slate" : "blue"}>{r.status.replace("_", " ")}</Chip>
                      <div className="text-xs text-slate-500">asked {fmtDate(r.requested_at)}</div>
                    </Td>
                    <Td muted>
                      {r.billed_on ? `Billed ${fmtDate(r.billed_on)}` : ""}
                      {r.delivered_on ? <div>Delivered {fmtDate(r.delivered_on)}</div> : null}
                    </Td>
                    <Td>
                      <Actions row={r} />
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

function Actions({ row }: { row: Row }) {
  const canApprove = useRightGate("dealer_transfers", "approve");
  const move = (status: string, note?: string | null) => rpc("move_dealer_transfer", { p_transfer_id: row.id, p_status: status, p_note: note ?? null });
  if (row.status === "requested")
    return (
      <div className="flex flex-col gap-1">
        {canApprove && <RunButton label="Approve" run={() => move("approved")} />}
        {canApprove && (
          <ActionForm tone="danger" label="Reject" hidden={{}} fields={[{ name: "why", placeholder: "Reason", required: true, width: "w-28" }]} action={async (fd) => { await move("rejected", str(fd, "why")); }} />
        )}
        <RunButton tone="light" label="Cancel" run={() => move("cancelled")} />
      </div>
    );
  if (row.status === "approved") return <RunButton label={row.direction === "outward" ? "Dispatched" : "Received"} run={() => move(row.direction === "outward" ? "dispatched" : "received")} />;
  if (row.status === "dispatched" || row.status === "received")
    return <ActionForm tone="light" label="CTDMS done" hidden={{}} fields={[{ name: "note", placeholder: "Note", width: "w-28" }]} action={async (fd) => { await move("ctdms_done", str(fd, "note")); }} />;
  return null;
}

function NewTransfer() {
  const me = useCurrentEmployee();
  const masters = useQuery(async () => {
    const [dealers, outlets, variants, colors] = await Promise.all([
      supabase.from("other_dealers").select("id, name").eq("is_active", true).order("name"),
      supabase.from("outlets").select("id, name").eq("is_active", true).order("name"),
      supabase.from("variants").select("id, name, tkm_suffix_code").eq("is_active", true).order("name"),
      supabase.from("colors").select("id, name").order("name"),
    ]);
    return {
      dealers: must(dealers) as Named[],
      outlets: must(outlets) as Named[],
      variants: (must(variants) as { id: string; name: string; tkm_suffix_code: string | null }[]).map((v) => ({ id: v.id, name: `${v.name} ${v.tkm_suffix_code ?? ""}` })),
      colors: must(colors) as Named[],
    };
  }, []);
  const [dir, setDir] = useState<"inward" | "outward">("inward");
  const [vin, setVin] = useState("");
  const [dealerName, setDealerName] = useState("");
  if (!masters.data) return null;
  const m = masters.data;
  return (
    <Card title="New transfer">
      <div className="space-y-2 px-3 py-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={dir} onChange={(v) => setDir(v as "inward" | "outward")} options={[{ id: "inward", name: "Inward (buying in)" }, { id: "outward", name: "Outward (sending out)" }]} />
          <input className={`${inputCls} font-mono`} placeholder="VIN" value={vin} onChange={(e) => setVin(e.target.value.toUpperCase())} />
          <span className="text-xs text-slate-500">New dealer:</span>
          <input className={inputCls} placeholder="Dealer name" value={dealerName} onChange={(e) => setDealerName(e.target.value)} />
          <RunButton
            tone="light"
            label="Add dealer"
            disabled={!dealerName.trim()}
            run={async () => {
              must(await supabase.from("other_dealers").insert({ name: dealerName.trim() }));
              setDealerName("");
              masters.reload();
            }}
          />
        </div>
        <ActionForm
          label="Request"
          hidden={{}}
          fields={[
            { name: "dealer", placeholder: "Other dealer", options: m.dealers, required: true, width: "w-44" },
            ...(dir === "inward"
              ? [
                  { name: "outlet", placeholder: "Our branch", options: m.outlets, required: true, width: "w-40", initial: me?.outletId ?? "" },
                  { name: "variant", placeholder: "Variant", options: m.variants, required: true, width: "w-48" },
                  { name: "color", placeholder: "Colour", options: m.colors, required: true, width: "w-36" },
                  { name: "booking", placeholder: "For customer: booking / CTDMS order no.", width: "w-56" },
                ]
              : []),
            { name: "to", placeholder: "Transfer order no.", width: "w-36" },
            { name: "reason", placeholder: "Reason", required: true, width: "w-48" },
          ]}
          action={async (fd) => {
            if (vin.length !== 17) throw new Error("Enter the 17-character VIN");
            if (dir === "outward") {
              const { data } = await supabase.from("vehicles").select("id").eq("vin", vin).maybeSingle();
              if (!data) throw new Error("No car with that VIN in our stock");
              await rpc("request_dealer_transfer", {
                p: { direction: "outward", other_dealer_id: str(fd, "dealer"), vehicle_id: data.id, transfer_order_no: str(fd, "to"), reason: str(fd, "reason") },
              });
            } else {
              let bookingId: string | null = null;
              const ref = str(fd, "booking");
              if (ref) {
                const { data } = await supabase.from("bookings").select("id").or(`ctdms_order_booking_no.eq.${ref.replace(/[,()]/g, "")},id.eq.${/^[0-9a-f-]{36}$/.test(ref) ? ref : "00000000-0000-0000-0000-000000000000"}`).limit(2);
                if (!data || data.length !== 1) throw new Error("Booking not found");
                bookingId = data[0].id;
              }
              await rpc("request_dealer_transfer", {
                p: {
                  direction: "inward",
                  other_dealer_id: str(fd, "dealer"),
                  outlet_id: str(fd, "outlet"),
                  vin,
                  variant_id: str(fd, "variant"),
                  color_id: str(fd, "color"),
                  booking_id: bookingId,
                  transfer_order_no: str(fd, "to"),
                  reason: str(fd, "reason"),
                },
              });
            }
            setVin("");
          }}
        />
      </div>
    </Card>
  );
}
