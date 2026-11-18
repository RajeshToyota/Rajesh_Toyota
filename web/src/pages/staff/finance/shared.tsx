import type { CurrentEmployee } from "@/lib/auth";

export const FINANCE_STAGES = [
  { id: "docs_pending", label: "Documents pending" },
  { id: "logged_in", label: "Logged in" },
  { id: "sanctioned", label: "Sanctioned" },
  { id: "do_received", label: "DO received" },
  { id: "disbursed", label: "Disbursed" },
] as const;

export const stageLabel = (s: string) => (s === "rejected" ? "Rejected" : (FINANCE_STAGES.find((x) => x.id === s)?.label ?? s));

export const APPLICANT_LABELS: Record<string, string> = {
  salaried: "Salaried",
  self_employed: "Self-employed",
  company: "Company / firm",
};

export const isFinanceExecutive = (e: CurrentEmployee | null) => e?.roleName === "Finance Executive";
// Mirrors can_work_finance(): the branch's Finance Executive, its Outlet Head, or Business Head / Admin.
export const canWorkFinance = (e: CurrentEmployee | null, outletId: string | null) =>
  e?.roleRank != null &&
  (e.roleRank <= 1 || ((isFinanceExecutive(e) || e.roleRank === 2) && e.outletId === outletId));
export const canSeeFinance = (e: CurrentEmployee | null) => isFinanceExecutive(e) || (e?.roleRank != null && e.roleRank <= 3);

export const inr = (n: number | null | undefined) => (n == null ? "—" : `₹${Math.round(Number(n)).toLocaleString("en-IN")}`);
export const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("en-IN") : "—");
export const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
