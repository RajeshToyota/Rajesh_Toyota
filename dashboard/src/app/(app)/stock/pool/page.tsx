import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import type { PoolConfig, PoolOverviewRow } from "@/lib/pool";
import { poolRecomputeAll } from "../actions";
import { ActionForm } from "../ui";
import { Card, Chip, Empty, Restricted, Th, isBackOffice } from "../shared";
import { PoolNav } from "./nav";

// Every variant + colour pool: free cars, pool size, members and who has completed.
export default async function PoolOverviewPage() {
  const employee = await getCurrentEmployee();
  if (!isBackOffice(employee)) return <Restricted text="The allotment pool is for the back office and Outlet Heads." />;
  const supabase = await createClient();
  const [{ data: config }, { data, error }] = await Promise.all([
    supabase.from("pool_config").select("*").maybeSingle(),
    supabase.rpc("pool_overview"),
  ]);
  const rows = (data ?? []) as PoolOverviewRow[];
  const admin = employee?.roleRank != null && employee.roleRank <= 1;

  return (
    <>
      <PoolNav config={config as PoolConfig | null} />
      <Card
        title={`Pools (${rows.length})`}
        note={
          <>
            One pool per variant and colour, across all branches. The earliest bookings are in the pool; the first
            to get the DO (or clear {(config as PoolConfig | null)?.cash_payment_percentage ?? 70}% in cash) gets the
            oldest free car automatically.
          </>
        }
      >
        {error && <p className="px-3 py-2 text-sm text-red-600">{error.message}</p>}
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>Model · Variant</Th>
              <Th>Colour</Th>
              <Th right>Free cars</Th>
              <Th right>Pool size</Th>
              <Th right>In pool</Th>
              <Th right>Completed, waiting</Th>
              <Th right>Allotted by pool</Th>
              <Th right>Bookings waiting</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && <Empty cols={8} text="No free cars and no bookings waiting." />}
            {rows.map((r) => (
              <tr key={`${r.variant_id}:${r.color_id}`}>
                <td className="px-3 py-2">
                  <Link href={`/stock/pool/${r.variant_id}/${r.color_id}`} className="underline">
                    {r.model_name} {r.variant_name}
                  </Link>
                </td>
                <td className="px-3 py-2">{r.color_name}</td>
                <td className="px-3 py-2 text-right">{r.free_cars}</td>
                <td className="px-3 py-2 text-right">{r.pool_size}</td>
                <td className="px-3 py-2 text-right">{r.members}</td>
                <td className="px-3 py-2 text-right">{r.winners > 0 ? <Chip tone="emerald">{r.winners}</Chip> : 0}</td>
                <td className="px-3 py-2 text-right">{r.allotted}</td>
                <td className="px-3 py-2 text-right">
                  {r.waiting > r.free_cars ? <Chip tone="amber">{r.waiting}</Chip> : r.waiting}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {admin && (config as PoolConfig | null)?.enabled && (
        <div className="max-w-md">
          <p className="mb-1 text-xs text-slate-500">
            Pools recheck themselves on every change. Use this after a bulk data fix.
          </p>
          <ActionForm action={poolRecomputeAll} hidden={{}} label="Recheck every pool now" tone="light" />
        </div>
      )}
    </>
  );
}
