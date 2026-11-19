import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";

export type Line = {
  id?: string;
  line_type: string;
  scheme_master_code: string | null;
  tkm_share: number;
  dealer_share: number;
  prev_my_tkm_share: number | null;
  prev_my_dealer_share: number | null;
  is_customer_facing: boolean;
};
export type Scheme = {
  id: string;
  name: string;
  model_id: string;
  suffix_scope_list: string[] | null;
  valid_from: string;
  valid_to: string;
  models: { name: string } | null;
  scheme_line_items: Line[];
};


export function useModels() {
  return useQuery(async () => must(await supabase.from("models").select("id, name").eq("is_active", true).order("name")) as { id: string; name: string }[], []);
}
export function useCategories() {
  return useQuery(async () => must(await supabase.from("scheme_master").select("code, name, category").eq("is_active", true).order("code")) as { code: string; name: string; category: string }[], []);
}


export const emptyLine = (): Line => ({
  line_type: "",
  scheme_master_code: null,
  tkm_share: 0,
  dealer_share: 0,
  prev_my_tkm_share: null,
  prev_my_dealer_share: null,
  is_customer_facing: true,
});
