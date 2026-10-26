import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { ActionForm } from "@/components/action-form";
import { completeDelivery } from "../actions";

const CHECKS = [
  ["pdi_done", "PDI done"],
  ["accessories_fitted", "Accessories fitted and checked against the order"],
  ["fastag_fitted", "FASTag fitted"],
  ["documents_explained", "Documents explained"],
  ["demo_done", "Vehicle demo done"],
] as const;

// The delivery gate: what is still missing, the consultant's checklist from the app, and the
// final "Delivered" step (a Business Head may override an outstanding amount, with a reason).
export default async function DeliveryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const employee = await getCurrentEmployee();

  const { data: booking } = await supabase.from("bookings").select("id, status, customer_name").eq("id", id).maybeSingle();
  if (!booking) notFound();
  const [{ data: delivery }, { data: blockers, error: blockersError }] = await Promise.all([
    supabase.from("deliveries").select("*").eq("booking_id", id).maybeSingle(),
    supabase.rpc("delivery_blockers", { p_booking_id: id }),
  ]);
  const paths = [delivery?.handover_photo_path, delivery?.customer_signature_path].filter((p): p is string => !!p);
  const links = new Map<string, string>();
  if (paths.length) {
    const { data: signed } = await supabase.storage.from("booking-documents").createSignedUrls(paths, 600);
    for (const s of signed ?? []) if (s.path && s.signedUrl) links.set(s.path, s.signedUrl);
  }
  const list = (blockers ?? []) as string[];
  const onlyOutstanding = list.length > 0 && list.every((b) => b.startsWith("Outstanding"));
  const isBusinessHead = employee?.roleRank != null && employee.roleRank <= 1;
  const delivered = booking.status === "delivered";

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-md border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Checklist (filled on the app)</h2>
        <ul className="space-y-1 text-sm">
          {CHECKS.map(([k, label]) => (
            <li key={k} className={delivery?.[k] ? "text-slate-900" : "text-slate-400"}>
              {delivery?.[k] ? "✓" : "○"} {label}
            </li>
          ))}
          <li className={delivery?.handover_photo_path ? "text-slate-900" : "text-slate-400"}>
            {delivery?.handover_photo_path ? "✓" : "○"} Handover photo{" "}
            {delivery?.handover_photo_path && links.get(delivery.handover_photo_path) && (
              <a href={links.get(delivery.handover_photo_path)} target="_blank" rel="noreferrer" className="underline">
                view
              </a>
            )}
          </li>
          <li className={delivery?.customer_signature_path ? "text-slate-900" : "text-slate-400"}>
            {delivery?.customer_signature_path ? "✓" : "○"} Customer signature{" "}
            {delivery?.customer_signature_path && links.get(delivery.customer_signature_path) && (
              <a href={links.get(delivery.customer_signature_path)} target="_blank" rel="noreferrer" className="underline">
                view
              </a>
            )}
          </li>
        </ul>
      </section>

      <section className="rounded-md border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Delivery</h2>
        {delivered ? (
          <div className="text-sm">
            <p className="font-medium text-emerald-800">Delivered {delivery?.delivered_at ? new Date(delivery.delivered_at).toLocaleString("en-IN") : ""}</p>
            {delivery?.override_reason && (
              <p className="mt-1 text-amber-800">
                Delivered with ₹{Math.round(Number(delivery.outstanding_at_delivery)).toLocaleString("en-IN")} outstanding:{" "}
                {delivery.override_reason}
              </p>
            )}
          </div>
        ) : blockersError ? (
          <p className="text-sm text-red-600">{blockersError.message}</p>
        ) : (
          <>
            {list.length === 0 ? (
              <p className="mb-2 text-sm text-emerald-800">Everything is in. The car can be delivered.</p>
            ) : (
              <>
                <p className="text-sm text-slate-600">Still needed:</p>
                <ul className="mb-3 list-disc pl-5 text-sm text-amber-800">
                  {list.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </>
            )}
            {list.length === 0 && <ActionForm action={completeDelivery} hidden={{ booking_id: id }} label="Mark delivered" />}
            {onlyOutstanding && isBusinessHead && (
              <ActionForm
                action={completeDelivery}
                hidden={{ booking_id: id }}
                fields={[{ name: "override_reason", placeholder: "Why deliver with money outstanding?", required: true, width: "w-80" }]}
                label="Deliver with outstanding"
                tone="danger"
              />
            )}
            {onlyOutstanding && !isBusinessHead && (
              <p className="text-xs text-slate-500">Only a Business Head can deliver with money outstanding.</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
