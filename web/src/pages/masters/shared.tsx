import { useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { EntityManager } from "@/components/entity-manager";
import { findEntity } from "@/lib/entities";
import { isMasterDataAdmin, useCurrentEmployee } from "@/lib/auth";
import { useRbacStore, useRightGate } from "@/lib/rbac";
import { masterPages, type MasterPage, type MasterPageKey } from "@/lib/master-pages";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { PageHeader, Tabs } from "@/ui";

// May the signed-in employee write this master (Admin / Business Head, or the module's edit right)?
export function useCanWriteMaster(module: string) {
  const me = useCurrentEmployee();
  const right = useRightGate(module, "edit");
  return isMasterDataAdmin(me) || right;
}

// One masters screen: a header and tabs (listed in lib/master-pages), each tab either a generic
// entity editor or a custom panel from `panels`. Table tabs are also open to anyone with the
// "masters" view right, since this tab is the table's only page; custom panels need the page's own.
export function MasterTabs({
  page,
  title,
  note,
  panels = {},
}: {
  page: MasterPageKey;
  title: string;
  note?: ReactNode;
  panels?: Record<string, () => ReactNode>;
}) {
  const { module, tabs: allTabs } = masterPages[page] as MasterPage;
  // The tab lives in ?tab= so menu links can open a given tab, even when the page is already open.
  const [params, setParams] = useSearchParams();
  const setTab = (id: string) => setParams((p) => { p.set("tab", id); return p; }, { replace: true });
  const canWrite = useCanWriteMaster(module);
  const { available, isAdmin, rights } = useRbacStore();
  const canView = (key: string) => !available || isAdmin || rights.has(`${key}:view`);
  const tabs = allTabs.filter((t) => canView(module) || (t.entity && canView("masters")));
  if (tabs.length === 0) return <p className="py-10 text-center text-sm text-slate-500">You do not have access to this screen.</p>;
  const current = tabs.find((t) => t.id === params.get("tab")) ?? tabs[0];
  const config = current.entity ? findEntity(current.entity) : undefined;
  return (
    <div>
      <PageHeader title={title} note={note} />
      <Tabs current={current.id} onChange={setTab} tabs={tabs.map((t) => ({ id: t.id, label: t.label }))} />
      {config ? <EntityManager key={config.slug} config={config} canWrite={canWrite} /> : panels[current.id]?.()}
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
