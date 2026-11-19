import { useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { EntityManager } from "@/components/entity-manager";
import { findEntity } from "@/lib/entities";
import { isMasterDataAdmin, useCurrentEmployee } from "@/lib/auth";
import { useRightGate } from "@/lib/rbac";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { PageHeader, Tabs } from "@/ui";

// May the signed-in employee write this master (Admin / Business Head, or the module's edit right)?
export function useCanWriteMaster(module: string) {
  const me = useCurrentEmployee();
  const right = useRightGate(module, "edit");
  return isMasterDataAdmin(me) || right;
}

// One masters screen: a header and tabs, each tab either a generic entity editor (by slug) or a
// custom panel.
export function MasterTabs({
  title,
  note,
  module,
  tabs,
}: {
  title: string;
  note?: ReactNode;
  module: string;
  tabs: { id: string; label: string; entity?: string; render?: () => ReactNode }[];
}) {
  // The tab lives in ?tab= so menu links can open a given tab, even when the page is already open.
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? tabs[0].id;
  const setTab = (id: string) => setParams((p) => { p.set("tab", id); return p; }, { replace: true });
  const canWrite = useCanWriteMaster(module);
  const current = tabs.find((t) => t.id === tab) ?? tabs[0];
  const config = current.entity ? findEntity(current.entity) : undefined;
  return (
    <div>
      <PageHeader title={title} note={note} />
      <Tabs current={tab} onChange={setTab} tabs={tabs.map((t) => ({ id: t.id, label: t.label }))} />
      {config ? <EntityManager key={config.slug} config={config} canWrite={canWrite} /> : current.render?.()}
    </div>
  );
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
