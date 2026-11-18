import type { CurrentEmployee } from "@/lib/auth";

// Mirrors the database rules in 20261029000001_stock_allotment.sql so pages can hide what the
// database would refuse anyway.
export const BACK_OFFICE_MAX_RANK = 3; // imports, CTDMS to-do, proposals
export const STOCK_MANAGER_MAX_RANK = 2; // allot, release, swap, send for billing

export const isAccounts = (e: CurrentEmployee | null) => e?.roleName === "Accounts";
export const isBackOffice = (e: CurrentEmployee | null) => e?.roleRank != null && e.roleRank <= BACK_OFFICE_MAX_RANK;
export const canManageStock = (e: CurrentEmployee | null) => e?.roleRank != null && e.roleRank <= STOCK_MANAGER_MAX_RANK;

export const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
export const inr = (n: number | null | undefined) => (n == null ? "—" : `₹${Math.round(Number(n)).toLocaleString("en-IN")}`);
export const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("en-IN") : "—");

// Today's date in India, as YYYY-MM-DD.
export const todayIst = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

// Days since TKM invoiced the car, as of today (the report gives it as of the report date).
export function ageDays(v: { tkm_invoice_date: string | null; days_since_invoice: number | null }) {
  if (v.tkm_invoice_date) {
    return Math.max(0, Math.floor((Date.now() - new Date(`${v.tkm_invoice_date}T00:00:00+05:30`).getTime()) / 86_400_000));
  }
  return v.days_since_invoice;
}

export function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <th className={`px-3 py-2 font-medium text-slate-600 ${right ? "text-right" : "text-left"}`}>{children}</th>;
}

export function Empty({ cols, text }: { cols: number; text: string }) {
  return (
    <tr>
      <td colSpan={cols} className="px-3 py-6 text-center text-slate-400">
        {text}
      </td>
    </tr>
  );
}

export function Chip({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "amber" | "red" | "emerald" | "blue" }) {
  const styles = {
    slate: "bg-slate-100 text-slate-700",
    amber: "bg-amber-100 text-amber-800",
    red: "bg-red-100 text-red-700",
    emerald: "bg-emerald-100 text-emerald-800",
    blue: "bg-blue-100 text-blue-800",
  }[tone];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>{children}</span>;
}

export function Card({ title, note, children }: { title: string; note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-6 overflow-x-auto rounded-md border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-3 py-2">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {note && <p className="text-xs text-slate-500">{note}</p>}
      </div>
      {children}
    </section>
  );
}

export function Restricted({ text }: { text: string }) {
  return <p className="text-sm text-slate-600">{text}</p>;
}
