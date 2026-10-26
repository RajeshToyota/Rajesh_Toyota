import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// One booking's Welcome Docket for the back office: registration and delivery details, the
// documents collected (photos open through short-lived signed links) and the signed docket PDF.

const DOC_LABELS: Record<string, string> = {
  photo: "Passport Size Photograph",
  aadhaar: "Aadhar Card",
  pan_or_voter_id: "PAN Card / Voter ID",
  passport_or_driving_licence: "Passport / Driving License",
  telephone_bill: "Telephone Bill",
  salary_slips: "Latest 3 months Salary slip",
  form_16: "Form 16",
  bank_statement: "Bank Statement (last 6 months)",
  it_returns: "IT Returns (last 2 yrs)",
  balance_sheet: "Audited Balance Sheet / Banker's Verifications / Passbook",
  signature_verification: "Signature Verification / Down Payment receipt / Employer's Certificate / Board Resolution",
  memorandum: "Memorandum of Article / Statement of Loan Accounts / Proposal Form",
  partnership_deed: "Partnership Deed copy",
  partner_authority_letter: "Partner's Authority Letter",
  ncb_certificate: "NCB Certificate",
  employment_letter: "Letter of Employment",
  other: "Other",
};

const LABELS: Record<string, string> = {
  in_house: "In house",
  by_party: "By party",
  permanent: "Permanent",
  temporary: "Temporary",
  private: "Private",
  commercial: "Commercial",
  state: "State Permit",
  all_india: "All India Permit",
  residence: "Residence",
  office: "Office",
  cash: "Cash",
  card: "Credit Card",
};

type Named = { name: string };
type BookingRow = {
  id: string;
  order_booking_no: string | null;
  ctdms_order_booking_no: string | null;
  customer_name: string | null;
  status: string;
  total_amount: number | null;
  variants: (Named & { suffix: string | null; models: Named | Named[] | null }) | null;
  colors: Named | Named[] | null;
  outlets: Named | Named[] | null;
  employees: Named | Named[] | null;
};
type AccessoryItem = { accessory_id: string; name: string; part_no: string | null; qty: number; amount: number };
type ReferralItem = { name?: string; phone?: string; occupation?: string; car_owned?: string };

const inr = (n: number | null | undefined) => (n == null ? "—" : `₹${Math.round(Number(n)).toLocaleString("en-IN")}`);
const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 border-b border-slate-100 py-1.5 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="col-span-2 text-slate-900">{value === null || value === undefined || value === "" ? "—" : value}</dd>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-slate-200 bg-white p-4">
      <h2 className="mb-2 text-sm font-semibold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}

export default async function BookingDocketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: booking } = await supabase
    .from("bookings")
    .select(
      "id, order_booking_no, ctdms_order_booking_no, customer_name, customer_mobile, status, total_amount, mode_of_purchase, " +
        "created_at, variants(name, suffix, models(name)), colors(name), outlets(name), employees!bookings_employee_id_fkey(name)",
    )
    .eq("id", id)
    .maybeSingle();
  if (!booking) notFound();
  const b = booking as unknown as BookingRow;

  const { data: docket } = await supabase.from("welcome_dockets").select("*").eq("booking_id", id).maybeSingle();
  const { data: documents } = docket
    ? await supabase
        .from("docket_documents")
        .select("id, doc_type, label, storage_path, collected_on_paper, created_at")
        .eq("docket_id", docket.id)
        .order("created_at")
    : { data: [] };

  const paths = [
    ...(documents ?? []).map((d) => d.storage_path).filter((p): p is string => !!p),
    ...(docket?.pdf_storage_path ? [docket.pdf_storage_path] : []),
  ];
  const links = new Map<string, string>();
  if (paths.length) {
    const { data: signed } = await supabase.storage.from("booking-documents").createSignedUrls(paths, 600);
    for (const s of signed ?? []) if (s.path && s.signedUrl) links.set(s.path, s.signedUrl);
  }

  const variant = b.variants;
  const vehicle = `${one(variant?.models ?? null)?.name ?? ""} ${variant?.name ?? ""}`.trim();
  const colorName = one(b.colors)?.name;
  const label = (v: string | null | undefined) => (v ? (LABELS[v] ?? v) : null);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <Link href="/reports/bookings" className="text-sm text-slate-500 hover:underline">
            ← Bookings
          </Link>
          <h2 className="mt-1 text-base font-semibold text-slate-900">
            {b.customer_name ?? "Booking"} · {vehicle} {colorName ? `· ${colorName}` : ""}
          </h2>
          <p className="text-sm text-slate-500">
            {b.order_booking_no ?? b.ctdms_order_booking_no ?? "No booking number"} · {one(b.outlets)?.name} ·{" "}
            {one(b.employees)?.name ?? "—"} · {inr(b.total_amount)} · {b.status}
          </p>
        </div>
        {docket?.pdf_storage_path && links.get(docket.pdf_storage_path) && (
          <a
            href={links.get(docket.pdf_storage_path)}
            target="_blank"
            rel="noreferrer"
            className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white"
          >
            Open Docket PDF
          </a>
        )}
      </div>

      {!docket ? (
        <p className="rounded-md bg-slate-50 px-3 py-6 text-center text-sm text-slate-500">
          The Welcome Docket has not been started. The Sales Consultant fills it in on the mobile app.
        </p>
      ) : (
        <>
          <p
            className={`rounded-md px-3 py-2 text-sm ${docket.status === "complete" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}
          >
            {docket.status === "complete"
              ? `Complete since ${new Date(docket.completed_at).toLocaleString("en-IN")}`
              : `In progress${docket.reopened_reason ? ` — reopened: ${docket.reopened_reason}` : ""}`}
          </p>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Contact">
              <dl>
                <Detail label="Mobile" value={docket.mobile} />
                <Detail label="Phone" value={docket.alt_phone} />
                <Detail label="Email" value={docket.email} />
                <Detail
                  label="Address"
                  value={docket.communication_address ? `${docket.communication_address}${docket.address_type ? ` (${label(docket.address_type)})` : ""}` : null}
                />
                <Detail label="PIN" value={docket.pin} />
              </dl>
            </Card>

            <Card title="Registration & Delivery">
              <dl>
                <Detail label="Father / Husband" value={docket.father_or_husband_name} />
                <Detail label="Registration address" value={docket.registration_address} />
                <Detail label="Hypothecated to" value={docket.hypothecated_to} />
                <Detail label="Insurance" value={label(docket.insurance_coverage)} />
                <Detail
                  label="Registration"
                  value={[label(docket.registration_period), label(docket.registration_use), label(docket.permit_type)].filter(Boolean).join(" · ")}
                />
                <Detail label="RTO location" value={docket.rto_location} />
                <Detail label="Special number" value={docket.special_registration_number} />
                <Detail label="Delivery" value={[docket.delivery_at ? new Date(docket.delivery_at).toLocaleString("en-IN") : null, docket.delivery_place].filter(Boolean).join(" · ")} />
                <Detail
                  label="TR / RC / HSRP"
                  value={[docket.temp_registration_validity_days, docket.rc_days, docket.hsrp_days].map((d) => (d ? `${d} days` : "—")).join(" / ")}
                />
              </dl>
            </Card>

            <Card title="Documents">
              {(documents ?? []).length === 0 ? (
                <p className="text-sm text-slate-400">No documents yet.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {(documents ?? []).map((d) => (
                    <li key={d.id} className="flex justify-between gap-2">
                      <span>
                        {DOC_LABELS[d.doc_type] ?? d.doc_type}
                        {d.label ? ` — ${d.label}` : ""}
                      </span>
                      {d.storage_path && links.get(d.storage_path) ? (
                        <a href={links.get(d.storage_path)} target="_blank" rel="noreferrer" className="text-slate-900 underline">
                          View
                        </a>
                      ) : (
                        <span className="text-slate-500">{d.collected_on_paper ? "On paper" : "—"}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Accessories Order">
              {(docket.accessory_order_items ?? []).length === 0 ? (
                <p className="text-sm text-slate-400">No accessories ordered.</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {(docket.accessory_order_items as AccessoryItem[]).map((a) => (
                      <tr key={a.accessory_id} className="border-b border-slate-100">
                        <td className="py-1">
                          {a.name} <span className="text-xs text-slate-400">{a.part_no}</span>
                        </td>
                        <td className="py-1 text-right">× {a.qty}</td>
                        <td className="py-1 text-right">{inr(a.amount)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td className="py-1 font-medium">Total · advance {inr(docket.accessories_advance)}</td>
                      <td />
                      <td className="py-1 text-right font-medium">{inr(docket.accessories_total)}</td>
                    </tr>
                  </tbody>
                </table>
              )}
              <p className="mt-2 text-sm text-slate-500">Payment: {label(docket.accessories_payment_mode) ?? "—"}</p>
            </Card>

            <Card title="Programmes & Referrals">
              <dl>
                <Detail
                  label="Interested in"
                  value={[
                    docket.utrust_interest && "U Trust",
                    docket.tconnect_interest && "Toyota Connect",
                    docket.extended_warranty_interest && "Extended Warranty",
                    docket.smiles_interest && "Smiles Plus",
                  ]
                    .filter(Boolean)
                    .join(", ")}
                />
                {(docket.referrals as ReferralItem[]).map((r, i) => (
                  <Detail key={i} label={`Referral ${i + 1}`} value={[r.name, r.phone, r.occupation, r.car_owned].filter(Boolean).join(" · ")} />
                ))}
              </dl>
            </Card>

            <Card title="Terms & Signatures">
              <dl>
                <Detail label="Order terms accepted" value={docket.terms_accepted ? "Yes" : "No"} />
                <Detail label="RTO terms accepted" value={docket.rto_terms_accepted ? "Yes" : "No"} />
                <Detail label="Customer signature" value={docket.customer_signature_path ? "Signed" : "Not yet"} />
                <Detail label="Consultant signature" value={docket.consultant_signature_path ? "Signed" : "Not yet"} />
              </dl>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
