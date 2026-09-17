import { notFound } from "next/navigation";
import Link from "next/link";
import { findEntity } from "@/lib/entities";
import { EntityManager } from "@/components/entity-manager";
import { getCurrentEmployee, isMasterDataAdmin } from "@/lib/auth";

export default async function EntityPage({
  params,
}: {
  params: Promise<{ entity: string }>;
}) {
  const { entity } = await params;
  const config = findEntity(entity);
  if (!config) notFound();

  const employee = await getCurrentEmployee();
  const canWrite = isMasterDataAdmin(employee);

  return (
    <div>
      {!canWrite && (
        <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          You have read-only access to master data. Only Admin and Business Head roles can make
          changes here.
        </p>
      )}
      {entity === "price-list" && canWrite && (
        <div className="mb-4">
          <Link
            href="/admin/price-list/import"
            className="inline-block rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
          >
            Import from CSV
          </Link>
        </div>
      )}
      <EntityManager config={config} canWrite={canWrite} />
    </div>
  );
}
