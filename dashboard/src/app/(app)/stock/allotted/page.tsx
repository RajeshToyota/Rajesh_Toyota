import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { releaseAllotment, sendForBilling } from "../actions";
import { ActionForm } from "../ui";
import { Card, Chip, Empty, Restricted, Th, canManageStock, fmtDate, isBackOffice, one } from "../shared";

type Row = {
  id: string;
  method: string;
  allotted_at: string;
  vehicles: { id: string; vin: string; source: string; missing_from_report: boolean } | null;
  bookings: {
    id: string;
    customer_name: string | null;
    ctdms_order_booking_no: string | null;
    status: string;
    outlets: { name: string } | null;
    variants: { name: string } | null;
    colors: { name: string } | null;
    welcome_dockets: { status: string } | { status: string }[] | null;
    billing_requests: { status: string }[] | null;
  } | null;
};

// Cars allotted and not yet sent for billing (and those waiting for their invoice).
export default async function AllottedPage() {
  const employee = await getCurrentEmployee();
  if (!isBackOffice(employee)) return <Restricted text="Allotted stock is for the back office and Outlet Heads." />;
  const supabase = await createClient();
  const canAct = canManageStock(employee);

  const { data } = await supabase
    .from("allotments")
    .select(
      "id, method, allotted_at, vehicles(id, vin, source, missing_from_report), " +
        "bookings(id, customer_name, ctdms_order_booking_no, status, outlets(name), variants(name), colors(name), welcome_dockets(status), billing_requests(status))",
    )
    .is("released_at", null)
    .order("allotted_at", { ascending: true })
    .limit(1000);
  const rows = (data ?? []) as unknown as Row[];

  return (
    <Card
      title={`Allotted (${rows.length})`}
      note="Send for billing once the car is in the yard and the Welcome Docket is complete. Accounts then records the invoice."
    >
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>
            <Th>Customer</Th>
            <Th>Order</Th>
            <Th>Branch</Th>
            <Th>Car</Th>
            <Th>Allotted</Th>
            <Th>Docket</Th>
            <Th>Billing</Th>
            {canAct && <Th />}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.length === 0 && <Empty cols={canAct ? 8 : 7} text="No cars allotted." />}
          {rows.map((a) => {
            const b = a.bookings;
            const v = a.vehicles;
            const docket = one(b?.welcome_dockets ?? null);
            const billing = (b?.billing_requests ?? []).find((r) => r.status !== "cancelled");
            const ready = v?.source === "physical" && docket?.status === "complete" && !v.missing_from_report;
            return (
              <tr key={a.id}>
                <td className="px-3 py-2">
                  {b ? (
                    <Link href={`/reports/bookings/${b.id}`} className="underline">
                      {b.customer_name ?? "—"}
                    </Link>
                  ) : (
                    "—"
                  )}
                  <div className="text-xs text-slate-500">
                    {b?.variants?.name} · {b?.colors?.name}
                  </div>
                </td>
                <td className="px-3 py-2">{b?.ctdms_order_booking_no ?? "—"}</td>
                <td className="px-3 py-2">{b?.outlets?.name ?? "—"}</td>
                <td className="px-3 py-2">
                  <Link href={`/stock/vehicle/${v?.id}`} className="font-mono text-xs underline">
                    {v?.vin}
                  </Link>{" "}
                  {v?.source === "transit" && <Chip tone="blue">In transit</Chip>}
                  {v?.missing_from_report && <Chip tone="red">Missing from report</Chip>}
                </td>
                <td className="px-3 py-2">
                  {fmtDate(a.allotted_at)} <span className="text-xs text-slate-400">{a.method}</span>
                </td>
                <td className="px-3 py-2">
                  {docket?.status === "complete" ? <Chip tone="emerald">Complete</Chip> : <Chip tone="amber">{docket ? "In progress" : "Not started"}</Chip>}
                </td>
                <td className="px-3 py-2">
                  {billing ? <Chip tone={billing.status === "invoiced" ? "emerald" : "blue"}>{billing.status === "invoiced" ? "Invoiced" : "Sent"}</Chip> : "—"}
                </td>
                {canAct && (
                  <td className="space-y-1 px-3 py-2">
                    {!billing && (
                      <>
                        {ready ? (
                          <ActionForm action={sendForBilling} hidden={{ booking_id: b?.id ?? "" }} label="Send for billing" />
                        ) : (
                          <p className="text-xs text-slate-400">
                            {v?.source === "transit" ? "In transit" : docket?.status !== "complete" ? "Docket not complete" : "Check CTDMS"}
                          </p>
                        )}
                        <ActionForm
                          action={releaseAllotment}
                          hidden={{ allotment_id: a.id }}
                          fields={[{ name: "reason", placeholder: "Reason", required: true, width: "w-32" }]}
                          label="Release"
                          tone="danger"
                        />
                      </>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
