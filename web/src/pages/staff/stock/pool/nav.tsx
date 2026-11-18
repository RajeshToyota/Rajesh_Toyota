import Link from "next/link";
import type { PoolConfig } from "@/lib/pool";
import { Chip } from "../shared";

// Links between the pool's pages, and whether the pool is switched on.
// Sales and finance staff get only the queue pages.
export function PoolNav({ config, backOffice = true }: { config: PoolConfig | null; backOffice?: boolean }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
      {backOffice && (
        <Link href="/stock/pool" className="underline">
          Pools
        </Link>
      )}
      <Link href="/stock/finance-queue" className="underline">
        Finance Queue
      </Link>
      <Link href="/stock/vna" className="underline">
        VNA Demand
      </Link>
      {backOffice && (
        <>
          <Link href="/stock/pool/audit" className="underline">
            Audit log
          </Link>
          <Link href="/stock/pool/config" className="underline">
            Settings
          </Link>
        </>
      )}
      {config &&
        (config.enabled ? (
          <Chip tone="emerald">
            Pool on · {config.base_pool_size} + {config.increment_per_vehicle} per extra car · cash {config.cash_payment_percentage}%
          </Chip>
        ) : (
          <Chip tone="amber">Pool switched off: cars are allotted from Match &amp; Allot only</Chip>
        ))}
    </div>
  );
}
