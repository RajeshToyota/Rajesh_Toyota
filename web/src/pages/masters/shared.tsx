import { useEffect, useState } from "react";
import { isMasterDataAdmin, useCurrentEmployee } from "@/lib/auth";
import { useRightGate } from "@/lib/rbac";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";

// May the signed-in employee write this master (Admin / Business Head, or the module's edit right)?
export function useCanWriteMaster(module: string) {
  const me = useCurrentEmployee();
  const right = useRightGate(module, "edit");
  return isMasterDataAdmin(me) || right;
}

export type VariantOption = { id: string; name: string; model_id: string; tkm_suffix_code: string | null; models: { name: string } | null };

export function useVariants() {
  return useQuery(
    async () =>
      must(
        await supabase.from("variants").select("id, name, model_id, tkm_suffix_code, models(name)").eq("is_active", true).order("name"),
      ) as unknown as VariantOption[],
    [],
  );
}

export const variantLabel = (v: VariantOption) => `${v.models?.name ?? ""} ${v.name}${v.tkm_suffix_code ? ` (${v.tkm_suffix_code})` : ""}`.trim();

// Uploads a file to the catalog-media bucket and returns its path.
export async function uploadCatalogFile(folder: string, file: File) {
  const path = `${folder}/${Date.now()}-${file.name.replace(/[^\w.-]+/g, "_")}`;
  const { error } = await supabase.storage.from("catalog-media").upload(path, file, { upsert: false });
  if (error) throw new Error(error.message);
  return path;
}

export async function catalogFileUrl(path: string) {
  const { data } = await supabase.storage.from("catalog-media").createSignedUrl(path, 3600);
  return data?.signedUrl ?? null;
}

export function SignedImage({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    catalogFileUrl(path).then(setUrl);
  }, [path]);
  return url ? <img src={url} alt="" className="h-28 w-40 rounded border border-slate-200 object-cover" /> : <div className="h-28 w-40 rounded bg-slate-100" />;
}
