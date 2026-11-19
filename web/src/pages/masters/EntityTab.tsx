import { EntityManager } from "@/components/entity-manager";
import { findEntity } from "@/lib/entities";
import { useCanWriteMaster } from "./shared";

// A master table as a tab of a Masters page (lib/tabbed-screens).
export default function EntityTab({ slug, module }: { slug: string; module: string }) {
  const canWrite = useCanWriteMaster(module);
  const config = findEntity(slug);
  if (!config) return <p className="py-10 text-center text-sm text-slate-500">Unknown table: {slug}</p>;
  return <EntityManager config={config} canWrite={canWrite} />;
}
