import { useState } from "react";
import { useQuery } from "@/lib/query";
import { Card, Loaded, PageHeader, Stat, Table, Td, rpc, titleCase } from "@/ui";
import { OutletPicker } from "@/pages/ops/shared";

type Monitor = {
  ready_for_billing: number;
  billed_not_delivered: number;
  outward_still_in_report: number;
  free: number;
  in_transit: number;
  controls: { state: string; reason: string | null; cars: number }[];
};

// Techwheels' Chassis Monitor: where the stock stands, and the mismatches to chase.
export default function Monitor() {
  const [outlet, setOutlet] = useState("");
  const q = useQuery(() => rpc<Monitor>("chassis_monitor", { p_outlet_id: outlet || null }, { refresh: false }), [outlet]);
  return (
    <div>
      <PageHeader title="Chassis Monitor" actions={<OutletPicker value={outlet} onChange={setOutlet} />} />
      <Loaded q={q}>
        {(m) => (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <Stat label="Free stock" value={m.free} />
              <Stat label="In transit" value={m.in_transit} />
              <Stat label="Sent for billing" value={m.ready_for_billing} />
              <Stat label="Billed, not delivered" value={m.billed_not_delivered} />
              <Stat label="Sent to dealers but still in the report" value={m.outward_still_in_report} tone={m.outward_still_in_report ? "red" : undefined} note="CTDMS not updated yet" />
            </div>
            <Card title="Stock control">
              <Table head={["", "Reason", "Cars"]}>
                {m.controls.length === 0 ? (
                  <tr>
                    <Td muted>No cars under control.</Td>
                  </tr>
                ) : (
                  m.controls.map((c) => (
                    <tr key={`${c.state}-${c.reason}`}>
                      <Td>{c.state === "add" ? "Added to free stock" : "Taken out of free stock"}</Td>
                      <Td>{titleCase(c.reason ?? "other")}</Td>
                      <Td right>{c.cars}</Td>
                    </tr>
                  ))
                )}
              </Table>
            </Card>
          </>
        )}
      </Loaded>
    </div>
  );
}
