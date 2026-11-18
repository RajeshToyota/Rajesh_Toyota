export const KINDS: Record<string, string> = {
  ca_retail: "CA retail",
  tl_team: "Team Leader",
  gm_sm: "GM / SM",
  prefinance: "Pre-finance",
};
export const HELD: Record<string, string> = { tkm_settlement: "TKM settlement", bank_payment: "Bank payment" };
export const firstOfMonth = (ym: string) => `${ym}-01`;
export const monthLabel = (d: string) => new Date(d).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
