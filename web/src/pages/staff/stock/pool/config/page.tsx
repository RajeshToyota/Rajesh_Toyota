import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import type { PoolConfig } from "@/lib/pool";
import { poolConfigUpdate } from "../../actions";
import { ActionForm } from "../../ui";
import { Card, Restricted, isBackOffice } from "../../shared";
import { PoolNav } from "../nav";

// Pool size, cash share and the on/off switch. Only a Business Head or Admin changes them.
export default async function PoolConfigPage() {
  const employee = await getCurrentEmployee();
  if (!isBackOffice(employee)) return <Restricted text="Pool settings are for the back office and Outlet Heads." />;
  const supabase = await createClient();
  const { data } = await supabase.from("pool_config").select("*").maybeSingle();
  const cfg = data as PoolConfig | null;
  const admin = employee?.roleRank != null && employee.roleRank <= 1;

  return (
    <>
      <PoolNav config={cfg} />
      <Card
        title="Pool settings"
        note="Pool size = base + increment × (free cars − 1). With one free car the pool holds the base number of bookings; each extra free car adds the increment."
      >
        <dl className="grid max-w-lg grid-cols-2 gap-2 px-3 py-3 text-sm">
          <dt className="text-slate-500">Pool</dt>
          <dd>{cfg?.enabled ? "On: cars are allotted automatically" : "Off: cars are allotted from Match & Allot"}</dd>
          <dt className="text-slate-500">Base pool size</dt>
          <dd>{cfg?.base_pool_size}</dd>
          <dt className="text-slate-500">Increment per extra free car</dt>
          <dd>{cfg?.increment_per_vehicle}</dd>
          <dt className="text-slate-500">Cash buyers complete at</dt>
          <dd>{cfg?.cash_payment_percentage}% of the deal amount cleared</dd>
          <dt className="text-slate-500">Financed buyers complete at</dt>
          <dd>Finance case reaches &quot;DO received&quot;</dd>
        </dl>
        {admin && cfg && (
          <div className="space-y-3 border-t border-slate-100 px-3 py-3">
            <ActionForm
              action={poolConfigUpdate}
              hidden={{}}
              fields={[
                { name: "base_pool_size", placeholder: "Base size", type: "number", width: "w-24", initial: String(cfg.base_pool_size) },
                { name: "increment_per_vehicle", placeholder: "Increment", type: "number", width: "w-24", initial: String(cfg.increment_per_vehicle) },
                { name: "cash_payment_percentage", placeholder: "Cash %", type: "number", width: "w-24", initial: String(cfg.cash_payment_percentage) },
              ]}
              label="Save sizes"
            />
            <ActionForm
              action={poolConfigUpdate}
              hidden={{ enabled: cfg.enabled ? "off" : "on" }}
              label={cfg.enabled ? "Switch the pool off" : "Switch the pool on"}
              tone={cfg.enabled ? "danger" : "dark"}
              confirm={
                cfg.enabled
                  ? "Switch the pool off? Cars already allotted stay allotted; new allotments go back to Match & Allot."
                  : "Switch the pool on? Every pool is checked now and cars are allotted to bookings that have completed."
              }
            />
          </div>
        )}
      </Card>
    </>
  );
}
