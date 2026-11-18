import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { Chip, Select, type Tone } from "@/ui";

export const STAGES = [
  { id: "billing", label: "Billing", module: "stock_billing", manual: false },
  { id: "accounts", label: "Accounts", module: "ops_accounts", manual: true },
  { id: "insurance", label: "Insurance", module: "ops_insurance", manual: false },
  { id: "rto", label: "RTO", module: "ops_rto", manual: false },
  { id: "accessories", label: "Accessories", module: "ops_accessories", manual: true },
  { id: "scheme", label: "Scheme", module: "ops_scheme", manual: true },
  { id: "scrap", label: "Scrap", module: "ops_scrap", manual: true },
  { id: "pdi", label: "PDI", module: "pdi_board", manual: false },
  { id: "gate_pass", label: "Gate Pass", module: "gate_pass", manual: false },
] as const;
export type StageId = (typeof STAGES)[number]["id"];

export type StageState = { status: "done" | "na" | "pending" | "blocked"; detail: string };

export const stageTone = (s?: StageState["status"]): Tone =>
  s === "done" ? "emerald" : s === "na" ? "slate" : s === "pending" ? "amber" : "slate";

export function StageChip({ stage, state }: { stage: string; state?: StageState }) {
  const label = STAGES.find((s) => s.id === stage)?.label ?? stage;
  return (
    <span title={state?.detail}>
      <Chip tone={stageTone(state?.status)}>
        {state?.status === "done" ? "✓ " : state?.status === "na" ? "– " : ""}
        {label}
      </Chip>
    </span>
  );
}

export type Outlet = { id: string; name: string };

export function useOutlets() {
  return useQuery(async () => must(await supabase.from("outlets").select("id, name").eq("is_active", true).order("name")) as Outlet[], []);
}

export function OutletPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const outlets = useOutlets();
  return <Select value={value} onChange={onChange} placeholder="All my branches" options={outlets.data ?? []} />;
}

export const carLine = (r: { model?: string | null; variant?: string | null; color?: string | null }) =>
  [r.model, r.variant, r.color].filter(Boolean).join(" · ");
