import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { Restricted, isBackOffice } from "../shared";
import { StockImportPanel } from "./import-panel";

export default async function StockImportPage() {
  const employee = await getCurrentEmployee();
  if (!isBackOffice(employee)) return <Restricted text="Stock uploads are for the back office." />;
  const supabase = await createClient();
  const { data: outlets } = await supabase
    .from("outlets")
    .select("id, name, city, ctdms_dealer_code")
    .eq("is_active", true)
    .order("name");
  return <StockImportPanel outlets={outlets ?? []} defaultOutletId={employee?.outletId ?? null} />;
}
