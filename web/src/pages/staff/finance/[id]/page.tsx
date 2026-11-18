import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { APPLICANT_LABELS, FINANCE_STAGES, canWorkFinance, fmtDate, inr, one, stageLabel } from "../shared";
import { StageActions, TermsForm } from "./case-forms";

type DocType = { id: string; label: string; applicant_types: string[]; required_for: string[]; sort_order: number };

export default async function FinanceCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const employee = await getCurrentEmployee();

  const { data: c } = await supabase
    .from("finance_cases")
    .select(
      "*, financiers(name), outlets(name), bookings(id, customer_name, customer_mobile, ctdms_order_booking_no, total_amount, " +
        "employees!bookings_employee_id_fkey(name), variants(name), colors(name))",
    )
    .eq("id", id)
    .maybeSingle();
  if (!c) notFound();
  const fc = c as unknown as Record<string, unknown> & {
    id: string;
    status: string;
    outlet_id: string;
    applicant_type: string;
    finance_type: string;
    emi: number | null;
    rejection_reason: string | null;
    financier_id: string;
    financiers: { name: string } | null;
    outlets: { name: string } | null;
    bookings: {
      id: string;
      customer_name: string | null;
      customer_mobile: string | null;
      ctdms_order_booking_no: string | null;
      total_amount: number | null;
      employees: { name: string } | { name: string }[] | null;
      variants: { name: string } | null;
      colors: { name: string } | null;
    } | null;
  };

  const [{ data: types }, { data: docs }, { data: events }, { data: financiers }] = await Promise.all([
    supabase.from("finance_document_types").select("*").order("sort_order"),
    supabase.from("finance_documents").select("id, doc_type, label, storage_path, collected_on_paper, created_at").eq("case_id", id).order("created_at"),
    supabase
      .from("finance_case_events")
      .select("id, status_from, status_to, note, created_at, employees:by_employee_id(name)")
      .eq("case_id", id)
      .order("created_at"),
    supabase.from("financiers").select("id, name").eq("is_active", true).order("name"),
  ]);

  const paths = (docs ?? []).map((d) => d.storage_path).filter((p): p is string => !!p);
  const links = new Map<string, string>();
  if (paths.length) {
    const { data: signed } = await supabase.storage.from("booking-documents").createSignedUrls(paths, 600);
    for (const s of signed ?? []) if (s.path && s.signedUrl) links.set(s.path, s.signedUrl);
  }

  const canWork = canWorkFinance(employee, fc.outlet_id);
  const closed = fc.status === "disbursed" || fc.status === "rejected";
  const idx = FINANCE_STAGES.findIndex((s) => s.id === fc.status);
  const next = !closed && idx >= 0 && idx < FINANCE_STAGES.length - 1 ? FINANCE_STAGES[idx + 1] : null;
  const checklist = ((types ?? []) as DocType[]).filter((t) => t.applicant_types.includes(fc.applicant_type));
  const b = fc.bookings;
  const str = (k: string) => (fc[k] == null ? "" : String(fc[k]));

  return (
    <div className="space-y-4">
      <div>
        <Link href="/finance" className="text-sm text-slate-500 hover:underline">
          ← Finance cases
        </Link>
        <h1 className="mt-1 text-lg font-semibold text-slate-900">
          {b?.customer_name ?? "—"} · {fc.financiers?.name}
        </h1>
        <p className="text-sm text-slate-600">
          {b?.variants?.name} · {b?.colors?.name} · booked price {inr(b?.total_amount)} · {fc.outlets?.name} ·{" "}
          {one(b?.employees ?? null)?.name ?? "—"} · {b?.customer_mobile ?? ""}
          {b && (
            <>
              {" "}
              ·{" "}
              <Link href={`/reports/bookings/${b.id}`} className="underline">
                booking
              </Link>
            </>
          )}
        </p>
        <p className="mt-1 text-sm">
          <b>{stageLabel(fc.status)}</b> · {APPLICANT_LABELS[fc.applicant_type]} · {fc.finance_type === "own" ? "own finance" : "in-house"}
          {fc.emi ? ` · EMI ${inr(fc.emi)}` : ""}
          {fc.rejection_reason ? ` · ${fc.rejection_reason}` : ""}
        </p>
      </div>

      <div className="flex gap-1">
        {FINANCE_STAGES.map((s, i) => (
          <div key={s.id} className="flex-1">
            <div className={`h-1.5 rounded-full ${fc.status !== "rejected" && i <= idx ? "bg-emerald-600" : "bg-slate-200"}`} />
            <p className={`mt-1 text-xs ${i === idx ? "font-semibold text-slate-900" : "text-slate-400"}`}>{s.label}</p>
          </div>
        ))}
      </div>

      {canWork && !closed && (
        <section className="rounded-md border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-900">Move the case</h2>
          <StageActions caseId={fc.id} next={next?.id ?? null} nextLabel={next?.label ?? null} />
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-md border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-900">Loan details</h2>
          <TermsForm
            caseId={fc.id}
            disabled={!canWork || closed}
            financiers={financiers ?? []}
            initial={Object.fromEntries(
              [
                "financier_id", "application_no", "login_date", "loan_amount", "tenure_months", "roi_percent", "advance_emis",
                "processing_fee", "sanction_date", "do_number", "do_amount", "do_date", "disbursed_amount", "disbursed_date", "notes",
              ].map((k) => [k, str(k)]),
            )}
          />
        </section>

        <section className="rounded-md border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-900">Documents ({APPLICANT_LABELS[fc.applicant_type]} checklist)</h2>
          <ul className="space-y-1 text-sm">
            {checklist.map((t) => {
              const have = (docs ?? []).filter((d) => d.doc_type === t.id);
              const required = t.required_for.includes(fc.applicant_type);
              return (
                <li key={t.id} className="flex justify-between gap-3 border-b border-slate-100 py-1">
                  <span className={have.length ? "text-slate-900" : required ? "text-amber-700" : "text-slate-400"}>
                    {have.length ? "✓ " : ""}
                    {t.label}
                    {required ? " *" : ""}
                  </span>
                  <span className="flex shrink-0 gap-2">
                    {have.map((d, i) =>
                      d.storage_path && links.get(d.storage_path) ? (
                        <a key={d.id} href={links.get(d.storage_path)} target="_blank" rel="noreferrer" className="underline">
                          View{have.length > 1 ? ` ${i + 1}` : ""}
                        </a>
                      ) : (
                        <span key={d.id} className="text-slate-500">
                          On paper
                        </span>
                      ),
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-slate-500">* needed before the case can be logged in. The consultant adds documents on the app.</p>
        </section>
      </div>

      <section className="rounded-md border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-900">History</h2>
        <ul className="space-y-1 text-sm">
          {(events ?? []).map((e) => (
            <li key={e.id}>
              {fmtDate(e.created_at)} · {e.status_from ? `${stageLabel(e.status_from)} → ` : ""}
              {stageLabel(e.status_to)} · {one(e.employees as { name: string } | { name: string }[] | null)?.name ?? "—"}
              {e.note ? ` — ${e.note}` : ""}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
