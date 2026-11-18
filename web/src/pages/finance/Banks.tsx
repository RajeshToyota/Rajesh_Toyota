import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, RunButton, Select, Table, Tabs, Td, inr, inputCls, rpcRows, str } from "@/ui";

type Financier = {
  id: string;
  name: string;
  short_name: string | null;
  is_captive: boolean;
  is_active: boolean;
  executive_name: string | null;
  executive_mobile: string | null;
  manager_name: string | null;
  manager_mobile: string | null;
  payout_portal_url: string | null;
  payout_portal_username: string | null;
  bank_payout_basis: string;
  bank_payout_rate: number;
  ca_payout_basis: string;
  ca_payout_rate: number;
  addon_payout_basis: string;
  addon_payout_rate: number;
  addon_target_amount: number | null;
  target_period: string;
  gst_included: boolean;
  invoice_by_branch: boolean;
  letter_format: string;
};
type Slab = { id: string; is_no_score: boolean; cibil_from: number | null; cibil_to: number | null; roi_percent: number; roi_above_5yr_percent: number | null };
type Term = { id: string; max_tenure_months: number; max_ltv_percent: number; fee_type: string; fee_value: number };

const rate = (basis: string, r: number) => (basis === "percent" ? `${r}% of DO` : `${inr(r)} / file`);

// Techwheels' Banks: contacts, payout rates and the claim set-up per financier, its branches, EMI terms
// and CIBIL rate bands, plus an EMI comparison.
export default function Banks() {
  const canEdit = useRightGate("finance_banks", "edit");
  const [tab, setTab] = useState("banks");
  const q = useQuery(async () => must(await supabase.from("financiers").select("*").order("name")) as Financier[], []);
  return (
    <div>
      <PageHeader title="Banks" note="Payout = % of the month's DO, or an amount per file. The add-on is paid only when the month's DO reaches the target. The portal password is not kept here." />
      <Tabs current={tab} onChange={setTab} tabs={[{ id: "banks", label: "Banks & payouts" }, { id: "rates", label: "EMI terms & rates" }, { id: "compare", label: "Compare EMIs" }]} />
      <Loaded q={q}>
        {(rows) => (tab === "banks" ? <BankList rows={rows} canEdit={canEdit} reload={q.reload} /> : tab === "rates" ? <Rates rows={rows} canEdit={canEdit} /> : <Compare />)}
      </Loaded>
    </div>
  );
}

function BankList({ rows, canEdit, reload }: { rows: Financier[]; canEdit: boolean; reload: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card>
      <Table head={["Bank", "Contacts", "Bank payout", "CA payout", "Add-on", "Claim", ""]}>
        {rows.length === 0 ? (
          <EmptyRow cols={7} text="No banks." />
        ) : (
          rows.flatMap((f) => [
            <tr key={f.id} className={f.is_active ? "" : "opacity-50"}>
              <Td>
                {f.name} {f.is_captive && <Chip>captive</Chip>}
              </Td>
              <Td muted>
                {f.executive_name} {f.executive_mobile}
                <div className="text-xs">{[f.manager_name, f.manager_mobile].filter(Boolean).join(" ")}</div>
              </Td>
              <Td>{rate(f.bank_payout_basis, f.bank_payout_rate)}</Td>
              <Td>{rate(f.ca_payout_basis, f.ca_payout_rate)}</Td>
              <Td>
                {f.addon_payout_rate ? rate(f.addon_payout_basis, f.addon_payout_rate) : "—"}
                {f.addon_target_amount != null && <div className="text-xs text-slate-500">from {inr(f.addon_target_amount)} / {f.target_period}</div>}
              </Td>
              <Td muted>
                {f.gst_included ? "GST included" : "+ GST"} · {f.invoice_by_branch ? "per branch" : "all branches"}
              </Td>
              <Td>{canEdit && <button type="button" className="text-sm text-blue-700 hover:underline" onClick={() => setOpen(open === f.id ? null : f.id)}>{open === f.id ? "Close" : "Edit"}</button>}</Td>
            </tr>,
            open === f.id && (
              <tr key={`${f.id}-edit`}>
                <td colSpan={7} className="bg-slate-50 px-3 py-3">
                  <BankForm f={f} onSaved={() => { setOpen(null); reload(); }} />
                </td>
              </tr>
            ),
          ])
        )}
      </Table>
    </Card>
  );
}

function BankForm({ f, onSaved }: { f: Financier; onSaved: () => void }) {
  const [v, setV] = useState({ ...f });
  const set = (k: keyof Financier, val: unknown) => setV((x) => ({ ...x, [k]: val }));
  const text = (k: keyof Financier, label: string) => (
    <label className="text-xs text-slate-500">
      {label}
      <input className={`${inputCls} block w-44`} value={(v[k] as string | null) ?? ""} onChange={(e) => set(k, e.target.value || null)} />
    </label>
  );
  const num = (k: keyof Financier, label: string) => (
    <label className="text-xs text-slate-500">
      {label}
      <input className={`${inputCls} block w-28`} type="number" value={(v[k] as number | null) ?? ""} onChange={(e) => set(k, e.target.value === "" ? null : Number(e.target.value))} />
    </label>
  );
  const basis = (k: keyof Financier) => (
    <Select value={v[k] as string} onChange={(x) => set(k, x)} options={[{ id: "percent", name: "% of DO" }, { id: "per_file", name: "₹ per file" }]} />
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        {text("executive_name", "Executive")}
        {text("executive_mobile", "Executive mobile")}
        {text("manager_name", "Manager")}
        {text("manager_mobile", "Manager mobile")}
        {text("payout_portal_url", "Payout portal link")}
        {text("payout_portal_username", "Portal username")}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <span className="text-xs text-slate-500">Bank payout {basis("bank_payout_basis")}</span>
        {num("bank_payout_rate", "Rate")}
        <span className="text-xs text-slate-500">CA payout {basis("ca_payout_basis")}</span>
        {num("ca_payout_rate", "Rate")}
        <span className="text-xs text-slate-500">Add-on {basis("addon_payout_basis")}</span>
        {num("addon_payout_rate", "Rate")}
        {num("addon_target_amount", "Add-on target (DO)")}
        <Select value={v.target_period} onChange={(x) => set("target_period", x)} options={[{ id: "monthly", name: "Monthly" }, { id: "quarterly", name: "Quarterly" }]} />
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-1"><input type="checkbox" checked={v.gst_included} onChange={(e) => set("gst_included", e.target.checked)} /> Payout includes GST</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={v.invoice_by_branch} onChange={(e) => set("invoice_by_branch", e.target.checked)} /> Invoice each branch separately</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={v.is_active} onChange={(e) => set("is_active", e.target.checked)} /> Active</label>
        <Select value={v.letter_format} onChange={(x) => set("letter_format", x)} options={[{ id: "generic", name: "Generic table" }, { id: "claim_letter", name: "Claim letter" }, { id: "tax_invoice", name: "Tax invoice" }]} />
        <RunButton
          label="Save"
          run={async () => {
            const { id, ...rest } = v;
            must(await supabase.from("financiers").update(rest).eq("id", id));
            onSaved();
          }}
        />
      </div>
      <Branches financierId={f.id} />
    </div>
  );
}

function Branches({ financierId }: { financierId: string }) {
  const q = useQuery(async () => must(await supabase.from("financier_branches").select("id, name, city, contact_name, contact_mobile").eq("financier_id", financierId).order("name")) as { id: string; name: string; city: string | null; contact_name: string | null; contact_mobile: string | null }[], [financierId]);
  return (
    <div>
      <p className="text-xs font-medium text-slate-600">Branches</p>
      <ul className="text-sm">
        {(q.data ?? []).map((b) => (
          <li key={b.id}>
            {b.name} <span className="text-slate-500">{[b.city, b.contact_name, b.contact_mobile].filter(Boolean).join(" · ")}</span>
          </li>
        ))}
      </ul>
      <ActionForm
        tone="light"
        label="Add branch"
        hidden={{}}
        fields={[
          { name: "name", placeholder: "Branch", required: true, width: "w-36" },
          { name: "city", placeholder: "City", width: "w-28" },
          { name: "contact", placeholder: "Contact", width: "w-32" },
          { name: "mobile", placeholder: "Mobile", width: "w-28" },
        ]}
        action={async (fd) => {
          must(await supabase.from("financier_branches").insert({ financier_id: financierId, name: str(fd, "name"), city: str(fd, "city"), contact_name: str(fd, "contact"), contact_mobile: str(fd, "mobile") }));
          q.reload();
        }}
      />
    </div>
  );
}

function Rates({ rows, canEdit }: { rows: Financier[]; canEdit: boolean }) {
  const [fid, setFid] = useState(rows[0]?.id ?? "");
  const data = useQuery(async () => {
    if (!fid) return { slabs: [] as Slab[], terms: [] as Term[] };
    const [s, t] = await Promise.all([
      supabase.from("financier_rate_slabs").select("id, is_no_score, cibil_from, cibil_to, roi_percent, roi_above_5yr_percent").eq("financier_id", fid).order("cibil_from"),
      supabase.from("financier_emi_terms").select("id, max_tenure_months, max_ltv_percent, fee_type, fee_value").eq("financier_id", fid).order("valid_from", { ascending: false }),
    ]);
    return { slabs: must(s) as Slab[], terms: must(t) as Term[] };
  }, [fid]);
  return (
    <>
      <div className="mb-3">
        <Select value={fid} onChange={setFid} options={rows.map((r) => ({ id: r.id, name: r.name }))} />
      </div>
      <Loaded q={data}>
        {({ slabs, terms }) => (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="CIBIL rate bands" note="Bands of one bank cannot overlap; one band can be for applicants with no score.">
              <Table head={["CIBIL", "ROI", "Above 5 years"]}>
                {slabs.length === 0 ? <EmptyRow cols={3} text="No bands." /> : slabs.map((s) => (
                  <tr key={s.id}>
                    <Td>{s.is_no_score ? "No score" : `${s.cibil_from}–${s.cibil_to}`}</Td>
                    <Td right>{s.roi_percent}%</Td>
                    <Td right>{s.roi_above_5yr_percent != null ? `${s.roi_above_5yr_percent}%` : "—"}</Td>
                  </tr>
                ))}
              </Table>
              {canEdit && (
                <div className="px-3 py-2">
                  <ActionForm
                    label="Add band"
                    hidden={{}}
                    fields={[
                      { name: "from", placeholder: "From (blank = no score)", type: "number", width: "w-40" },
                      { name: "to", placeholder: "To", type: "number", width: "w-20" },
                      { name: "roi", placeholder: "ROI %", type: "number", required: true, width: "w-20" },
                      { name: "roi5", placeholder: "ROI > 5 yr", type: "number", width: "w-24" },
                    ]}
                    action={async (fd) => {
                      const from = str(fd, "from");
                      must(
                        await supabase.from("financier_rate_slabs").insert({
                          financier_id: fid,
                          is_no_score: !from,
                          cibil_from: from ? Number(from) : null,
                          cibil_to: from ? Number(str(fd, "to")) : null,
                          roi_percent: Number(str(fd, "roi")),
                          roi_above_5yr_percent: str(fd, "roi5") ? Number(str(fd, "roi5")) : null,
                        }),
                      );
                      data.reload();
                    }}
                  />
                </div>
              )}
            </Card>
            <Card title="Terms">
              <Table head={["Max tenure", "Max LTV", "Fee"]}>
                {terms.length === 0 ? <EmptyRow cols={3} text="No terms." /> : terms.map((t) => (
                  <tr key={t.id}>
                    <Td>{t.max_tenure_months} months</Td>
                    <Td>{t.max_ltv_percent}%</Td>
                    <Td>{t.fee_type === "nil" ? "Nil" : t.fee_type === "flat" ? inr(t.fee_value) : `${t.fee_value}%`}</Td>
                  </tr>
                ))}
              </Table>
              {canEdit && (
                <div className="px-3 py-2">
                  <ActionForm
                    label="Add terms"
                    hidden={{}}
                    fields={[
                      { name: "ten", placeholder: "Max months", type: "number", required: true, width: "w-24" },
                      { name: "ltv", placeholder: "Max LTV %", type: "number", required: true, width: "w-24" },
                      { name: "ft", placeholder: "Fee", options: [{ id: "nil", name: "Nil" }, { id: "flat", name: "Flat ₹" }, { id: "percent", name: "% of loan" }], required: true, width: "w-28" },
                      { name: "fv", placeholder: "Fee value", type: "number", width: "w-24" },
                    ]}
                    action={async (fd) => {
                      must(await supabase.from("financier_emi_terms").insert({ financier_id: fid, max_tenure_months: Number(str(fd, "ten")), max_ltv_percent: Number(str(fd, "ltv")), fee_type: str(fd, "ft"), fee_value: Number(str(fd, "fv") ?? 0) }));
                      data.reload();
                    }}
                  />
                </div>
              )}
            </Card>
          </div>
        )}
      </Loaded>
    </>
  );
}

type Option = { financier: string; roi_percent: number; max_tenure_months: number; max_ltv_percent: number; loan_allowed: number; fee: number; emi: number; within_limits: boolean };

function Compare() {
  const [price, setPrice] = useState("2000000");
  const [loan, setLoan] = useState("1500000");
  const [months, setMonths] = useState("60");
  const [cibil, setCibil] = useState("");
  const q = useQuery(
    () => rpcRows<Option>("finance_emi_options", { p_vehicle_price: Number(price), p_loan: Number(loan), p_months: Number(months), p_cibil: cibil ? Number(cibil) : null }),
    [price, loan, months, cibil],
  );
  return (
    <Card>
      <div className="flex flex-wrap gap-2 px-3 py-2 text-sm">
        <input className={inputCls} type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="On-road price" />
        <input className={inputCls} type="number" value={loan} onChange={(e) => setLoan(e.target.value)} placeholder="Loan" />
        <input className={`${inputCls} w-24`} type="number" value={months} onChange={(e) => setMonths(e.target.value)} placeholder="Months" />
        <input className={`${inputCls} w-28`} type="number" value={cibil} onChange={(e) => setCibil(e.target.value)} placeholder="CIBIL (blank = none)" />
      </div>
      <Loaded q={q}>
        {(rows) => (
          <Table head={["Bank", "ROI", "EMI", "Fee", "Max loan", "Max tenure", ""]}>
            {rows.length === 0 ? <EmptyRow cols={7} text="No bank has terms and a rate band for this score." /> : rows.map((o) => (
              <tr key={o.financier}>
                <Td>{o.financier}</Td>
                <Td right>{o.roi_percent}%</Td>
                <Td right className="font-semibold">{inr(o.emi)}</Td>
                <Td right>{inr(o.fee)}</Td>
                <Td right>{inr(o.loan_allowed)} ({o.max_ltv_percent}%)</Td>
                <Td right>{o.max_tenure_months}</Td>
                <Td>{o.within_limits ? <Chip tone="emerald">OK</Chip> : <Chip tone="red">Outside limits</Chip>}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Loaded>
    </Card>
  );
}
