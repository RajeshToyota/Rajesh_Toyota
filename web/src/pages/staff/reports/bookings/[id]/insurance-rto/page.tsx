import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { ActionForm } from "@/components/action-form";
import { saveInsurance, saveRto } from "../actions";
import { FileUpload } from "../file-upload";

const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("en-IN") : "—");
const inr = (n: number | null | undefined) => (n == null ? "—" : `₹${Math.round(Number(n)).toLocaleString("en-IN")}`);

const HSRP = [
  { id: "not_applied", name: "HSRP not applied" },
  { id: "applied", name: "HSRP applied" },
  { id: "received", name: "HSRP received" },
  { id: "fitted", name: "HSRP fitted" },
];
const RC = [
  { id: "pending", name: "RC pending" },
  { id: "received", name: "RC received" },
  { id: "handed_over", name: "RC handed to customer" },
];

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 border-b border-slate-100 py-1.5 text-sm">
      <dt className="text-slate-500">{k}</dt>
      <dd className="col-span-2">{v === null || v === undefined || v === "" ? "—" : v}</dd>
    </div>
  );
}

export default async function InsuranceRtoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const employee = await getCurrentEmployee();

  const { data: booking } = await supabase.from("bookings").select("id, outlet_id, customer_name").eq("id", id).maybeSingle();
  if (!booking) notFound();

  const [{ data: policy }, { data: rto }, { data: providers }, { data: docket }] = await Promise.all([
    supabase.from("insurance_policies").select("*, insurance_providers(name)").eq("booking_id", id).maybeSingle(),
    supabase.from("rto_registrations").select("*").eq("booking_id", id).maybeSingle(),
    supabase.from("insurance_providers").select("id, name").order("name"),
    supabase.from("welcome_dockets").select("insurance_coverage, rto_location, registration_period, special_registration_number").eq("booking_id", id).maybeSingle(),
  ]);
  const paths = [policy?.policy_storage_path, rto?.tax_receipt_storage_path].filter((p): p is string => !!p);
  const links = new Map<string, string>();
  if (paths.length) {
    const { data: signed } = await supabase.storage.from("booking-documents").createSignedUrls(paths, 600);
    for (const s of signed ?? []) if (s.path && s.signedUrl) links.set(s.path, s.signedUrl);
  }

  const canEdit =
    employee?.roleRank != null && (employee.roleRank <= 1 || (employee.roleRank <= 3 && employee.outletId === booking.outlet_id));
  const providerName = (policy?.insurance_providers as { name: string } | null)?.name ?? policy?.insurer_name;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-md border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Insurance</h2>
        {docket?.insurance_coverage && (
          <p className="mb-2 text-xs text-slate-500">Docket: {docket.insurance_coverage === "in_house" ? "in-house insurance" : "insured by the customer's party"}</p>
        )}
        <dl>
          <Row k="Insurer" v={providerName} />
          <Row k="Policy no." v={policy?.policy_no} />
          <Row k="Cover" v={policy?.coverage} />
          <Row k="Premium / IDV" v={policy ? `${inr(policy.premium)} / ${inr(policy.idv)}` : null} />
          <Row k="Period" v={policy ? `${fmtDate(policy.start_date)} – ${fmtDate(policy.end_date)}` : null} />
          <Row k="Arranged" v={policy ? (policy.in_house ? "In-house" : "By party") : null} />
          <Row
            k="Policy copy"
            v={
              policy?.policy_storage_path && links.get(policy.policy_storage_path) ? (
                <a href={links.get(policy.policy_storage_path)} target="_blank" rel="noreferrer" className="underline">
                  View
                </a>
              ) : null
            }
          />
        </dl>
        {canEdit && (
          <div className="mt-3 space-y-2">
            <ActionForm
              action={saveInsurance}
              hidden={{ booking_id: id }}
              fields={[
                { name: "insurance_provider_id", placeholder: "Insurer…", options: providers ?? [], width: "w-48" },
                { name: "insurer_name", placeholder: "…or insurer name", width: "w-40" },
                { name: "policy_no", placeholder: "Policy no.", required: !policy, width: "w-36" },
                { name: "coverage", placeholder: "Cover (e.g. Comprehensive + zero dep)", width: "w-64" },
                { name: "premium", placeholder: "Premium ₹", type: "number", width: "w-28" },
                { name: "idv", placeholder: "IDV ₹", type: "number", width: "w-28" },
                { name: "start_date", placeholder: "From", type: "date", width: "w-36" },
                { name: "end_date", placeholder: "To", type: "date", width: "w-36" },
                {
                  name: "in_house",
                  placeholder: "Arranged…",
                  options: [
                    { id: "true", name: "In-house" },
                    { id: "false", name: "By party" },
                  ],
                  width: "w-32",
                },
              ]}
              label={policy ? "Update" : "Save policy"}
            />
            {policy && <FileUpload bookingId={id} folder="insurance" field="policy_storage_path" label="Upload policy copy" action={saveInsurance} />}
            <p className="text-xs text-slate-500">Blank fields keep what is saved.</p>
          </div>
        )}
      </section>

      <section className="rounded-md border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-900">RTO registration</h2>
        {docket && (
          <p className="mb-2 text-xs text-slate-500">
            Docket: {docket.registration_period ?? "—"} registration at {docket.rto_location ?? "—"}
            {docket.special_registration_number ? `, special number ${docket.special_registration_number}` : ""}
          </p>
        )}
        <dl>
          <Row k="Temporary (TR) no." v={rto ? `${rto.temp_reg_no ?? "—"} · ${fmtDate(rto.temp_reg_date)}` : null} />
          <Row k="Permanent no." v={rto ? `${rto.perm_reg_no ?? "—"} · ${fmtDate(rto.perm_reg_date)}` : null} />
          <Row k="HSRP" v={rto ? `${HSRP.find((h) => h.id === rto.hsrp_status)?.name} · ${fmtDate(rto.hsrp_date)}` : null} />
          <Row k="RC" v={rto ? `${RC.find((h) => h.id === rto.rc_status)?.name} · ${fmtDate(rto.rc_date)}` : null} />
          <Row k="Road tax" v={rto ? inr(rto.road_tax_amount) : null} />
          <Row
            k="Tax receipt"
            v={
              rto?.tax_receipt_storage_path && links.get(rto.tax_receipt_storage_path) ? (
                <a href={links.get(rto.tax_receipt_storage_path)} target="_blank" rel="noreferrer" className="underline">
                  View
                </a>
              ) : null
            }
          />
          <Row k="Notes" v={rto?.notes} />
        </dl>
        {canEdit && (
          <div className="mt-3 space-y-2">
            <ActionForm
              action={saveRto}
              hidden={{ booking_id: id }}
              fields={[
                { name: "temp_reg_no", placeholder: "TR no.", width: "w-36" },
                { name: "temp_reg_date", placeholder: "TR date", type: "date", width: "w-36" },
                { name: "perm_reg_no", placeholder: "Permanent no.", width: "w-36" },
                { name: "perm_reg_date", placeholder: "Reg. date", type: "date", width: "w-36" },
                { name: "hsrp_status", placeholder: "HSRP…", options: HSRP, width: "w-40" },
                { name: "hsrp_date", placeholder: "HSRP date", type: "date", width: "w-36" },
                { name: "rc_status", placeholder: "RC…", options: RC, width: "w-44" },
                { name: "rc_date", placeholder: "RC date", type: "date", width: "w-36" },
                { name: "road_tax_amount", placeholder: "Road tax ₹", type: "number", width: "w-28" },
                { name: "notes", placeholder: "Notes", width: "w-64" },
              ]}
              label={rto ? "Update" : "Save"}
            />
            <FileUpload bookingId={id} folder="rto" field="tax_receipt_storage_path" label="Upload tax-paid receipt" action={saveRto} />
            <p className="text-xs text-slate-500">Blank fields keep what is saved. Tax receipts are the proof for scheme claims.</p>
          </div>
        )}
      </section>
    </div>
  );
}
