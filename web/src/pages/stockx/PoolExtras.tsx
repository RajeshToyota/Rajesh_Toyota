import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, RunButton, Select, Stat, Table, Tabs, Td, fmtDate, fmtDateTime, inr, rpc, rpcRows, str } from "@/ui";
import { OutletPicker } from "@/pages/ops/shared";

type Next = {
  variant_id: string;
  color_id: string;
  model: string;
  variant: string;
  color: string;
  waiting: number;
  queue_position: number;
  booking_id: string;
  customer_name: string;
  customer_mobile: string | null;
  outlet: string;
  consultant: string | null;
  team_leader: string | null;
  booking_date: string;
  finance_status: string | null;
  financier: string | null;
};
type Pair = { id: string; label: string; adjustment_amount: number; is_active: boolean; base: { name: string } | null; upgraded: { name: string } | null };
type Cross = { booking_id: string; customer_name: string; booked_variant: string; allotted_variant: string; color: string; vin: string; kind: string; adjustment: number; allotted_at: string };
type Clear = { allotments: number; avg_hours: number | null; median_hours: number | null };

// Techwheels' Next in Line, cross-match pairs, average clear time and the pool reverts.
export default function PoolExtras() {
  const [tab, setTab] = useState("next");
  const [outlet, setOutlet] = useState("");
  const [days, setDays] = useState("30");
  const clear = useQuery(() => rpcRows<Clear>("pool_avg_clear_time", { p_days: Number(days) }), [days]);
  return (
    <div>
      <PageHeader
        title="Next in Line & Pairs"
        note="Customers next for variant + colours with no free car; pairs of suffixes that can stand in for each other; and taking a car back when the DO is withdrawn or billing is pulled back."
        actions={<OutletPicker value={outlet} onChange={setOutlet} />}
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Stat label="Cars won in the window" value={clear.data?.[0]?.allotments ?? "—"} />
        <Stat label="Average join → car" value={clear.data?.[0]?.avg_hours != null ? `${clear.data[0].avg_hours} h` : "—"} />
        <Stat label="Median join → car" value={clear.data?.[0]?.median_hours != null ? `${clear.data[0].median_hours} h` : "—"} />
        <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm">
          <p className="text-xs text-slate-500">Window</p>
          <Select value={days} onChange={setDays} options={[{ id: "7", name: "7 days" }, { id: "30", name: "30 days" }, { id: "90", name: "90 days" }]} />
        </div>
      </div>
      <Tabs current={tab} onChange={setTab} tabs={[{ id: "next", label: "Next in line" }, { id: "pairs", label: "Cross-match pairs" }, { id: "revert", label: "Reverts" }, { id: "settings", label: "Settings" }]} />
      {tab === "next" ? <NextInLine outlet={outlet} /> : tab === "pairs" ? <Pairs /> : tab === "revert" ? <Reverts /> : <Settings />}
    </div>
  );
}

function NextInLine({ outlet }: { outlet: string }) {
  const q = useQuery(() => rpcRows<Next>("pool_next_in_line", { p_outlet_id: outlet || null }), [outlet]);
  const sent = useQuery(async () => {
    const ids = (q.data ?? []).map((r) => r.booking_id);
    if (!ids.length) return new Map<string, string>();
    const rows = await rpcRows<{ booking_id: string; sent_at: string }>("whatsapp_last_sent", { p_context: "vna", p_booking_ids: ids });
    return new Map(rows.map((r) => [r.booking_id, r.sent_at]));
  }, [q.data]);
  return (
    <Card>
      <Loaded q={q}>
        {(rows) => (
          <Table head={["Car", "#", "Customer", "Consultant / TL", "Finance", ""]}>
            {rows.length === 0 ? (
              <EmptyRow cols={6} text="Every waiting customer has a free car in their variant and colour." />
            ) : (
              rows.map((r) => (
                <tr key={r.booking_id}>
                  <Td>
                    {r.model} {r.variant}
                    <div className="text-xs text-slate-500">
                      {r.color} · {r.waiting} waiting
                    </div>
                  </Td>
                  <Td right>{r.queue_position}</Td>
                  <Td>
                    {r.customer_name}
                    <div className="text-xs text-slate-500">
                      {r.customer_mobile} · booked {fmtDate(r.booking_date)}
                    </div>
                  </Td>
                  <Td muted>
                    {r.consultant}
                    <div className="text-xs">{r.team_leader}</div>
                  </Td>
                  <Td>{r.finance_status ? `${r.finance_status.replace(/_/g, " ")} · ${r.financier}` : "Cash"}</Td>
                  <Td>
                    <div className="flex flex-col gap-1">
                      {r.customer_mobile && (
                        <a
                          className="text-xs text-emerald-700 hover:underline"
                          href={`https://wa.me/91${r.customer_mobile.replace(/\D/g, "").slice(-10)}?text=${encodeURIComponent(`Dear ${r.customer_name}, your ${r.model} ${r.variant} (${r.color}) is next in line at Rajesh Toyota. We will call you as soon as the car arrives.`)}`}
                          target="_blank"
                          rel="noreferrer"
                          onClick={() => {
                            supabase.from("whatsapp_send_log").insert({ context: "vna", booking_id: r.booking_id, mobile: r.customer_mobile }).then(() => sent.reload());
                          }}
                        >
                          WhatsApp
                        </a>
                      )}
                      {sent.data?.get(r.booking_id) && <Chip tone="blue">sent {fmtDateTime(sent.data.get(r.booking_id))}</Chip>}
                      <ActionForm
                        tone="light"
                        label="Hold"
                        hidden={{}}
                        fields={[{ name: "why", placeholder: "Reason", required: true, width: "w-28" }]}
                        action={async (fd) => {
                          await rpc("pool_member_hold", { p_booking_id: r.booking_id, p_reason: str(fd, "why") });
                        }}
                      />
                    </div>
                  </Td>
                </tr>
              ))
            )}
          </Table>
        )}
      </Loaded>
    </Card>
  );
}

function Pairs() {
  const canEdit = useRightGate("stock_pool_config", "edit");
  const variants = useQuery(async () => must(await supabase.from("variants").select("id, name, tkm_suffix_code").eq("is_active", true).order("name")) as { id: string; name: string; tkm_suffix_code: string | null }[], []);
  const pairs = useQuery(
    async () =>
      must(
        await supabase
          .from("pool_cross_match_pairs")
          .select("id, label, adjustment_amount, is_active, base:variants!pool_cross_match_pairs_base_variant_id_fkey(name), upgraded:variants!pool_cross_match_pairs_upgraded_variant_id_fkey(name)")
          .order("created_at", { ascending: false }),
      ) as unknown as Pair[],
    [],
  );
  const cross = useQuery(() => rpcRows<Cross>("pool_cross_match_allotments"), []);
  const opts = (variants.data ?? []).map((v) => ({ id: v.id, name: `${v.name} ${v.tkm_suffix_code ?? ""}` }));
  return (
    <>
      {canEdit && (
        <Card title="New pair" note="A winner whose own suffix has no free car may take the paired suffix's car when none of that suffix's winners is waiting. Upgrade = booked the base, got the upgraded one.">
          <div className="px-3 py-2">
            <ActionForm
              label="Save pair"
              hidden={{}}
              fields={[
                { name: "base", placeholder: "Base variant", options: opts, required: true, width: "w-56" },
                { name: "up", placeholder: "Upgraded variant", options: opts, required: true, width: "w-56" },
                { name: "amt", placeholder: "Difference ₹", type: "number", required: true, width: "w-28" },
                { name: "label", placeholder: "What differs", required: true, width: "w-40" },
              ]}
              action={async (fd) => {
                await rpc("pool_pair_save", { p_base_variant_id: str(fd, "base"), p_upgraded_variant_id: str(fd, "up"), p_adjustment: Number(str(fd, "amt")), p_label: str(fd, "label") });
                pairs.reload();
              }}
            />
          </div>
        </Card>
      )}
      <Card title="Pairs">
        <Loaded q={pairs}>
          {(rows) => (
            <Table head={["Base", "Upgraded", "Difference", "", ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={5} text="No pairs." />
              ) : (
                rows.map((p) => (
                  <tr key={p.id} className={p.is_active ? "" : "opacity-50"}>
                    <Td>{p.base?.name}</Td>
                    <Td>{p.upgraded?.name}</Td>
                    <Td>
                      {inr(p.adjustment_amount)} · {p.label}
                    </Td>
                    <Td>{p.is_active ? <Chip tone="emerald">Active</Chip> : <Chip>Off</Chip>}</Td>
                    <Td>{canEdit && p.is_active && <RunButton tone="light" label="Switch off" run={async () => { await rpc("pool_pair_deactivate", { p_pair_id: p.id }); pairs.reload(); }} />}</Td>
                  </tr>
                ))
              )}
            </Table>
          )}
        </Loaded>
      </Card>
      <Card title="Cars allotted across a pair">
        <Loaded q={cross}>
          {(rows) => (
            <Table head={["Customer", "Booked", "Got", "VIN", "Adjustment"]}>
              {rows.length === 0 ? (
                <EmptyRow cols={5} text="None." />
              ) : (
                rows.map((c) => (
                  <tr key={c.booking_id}>
                    <Td>{c.customer_name}</Td>
                    <Td muted>{c.booked_variant}</Td>
                    <Td>
                      {c.allotted_variant} <Chip tone={c.kind === "upgrade" ? "emerald" : "amber"}>{c.kind}</Chip>
                    </Td>
                    <Td>
                      <span className="font-mono text-xs">{c.vin}</span>
                    </Td>
                    <Td right>{inr(c.adjustment)}</Td>
                  </tr>
                ))
              )}
            </Table>
          )}
        </Loaded>
      </Card>
    </>
  );
}

function Reverts() {
  const [search, setSearch] = useState("");
  const matches = useQuery(async () => {
    const safe = search.replace(/[,()%*]/g, " ").trim();
    if (safe.length < 3) return [] as { id: string; customer_name: string | null; ctdms_order_booking_no: string | null; status: string }[];
    return must(
      await supabase
        .from("bookings")
        .select("id, customer_name, ctdms_order_booking_no, status")
        .in("status", ["allocated", "ready_to_invoice"])
        .or(`customer_name.ilike.%${safe}%,ctdms_order_booking_no.ilike.%${safe}%`)
        .limit(10),
    ) as { id: string; customer_name: string | null; ctdms_order_booking_no: string | null; status: string }[];
  }, [search]);
  return (
    <Card title="Take a car back" note="DO withdrawn: the finance case goes back to sanctioned and the pool takes the car back. Billing pulled back (not invoiced): back to allotted, or the car returns to the pool.">
      <div className="space-y-2 px-3 py-2 text-sm">
        <input className="rounded-md border border-slate-300 px-2 py-1" placeholder="Customer or CTDMS order no." value={search} onChange={(e) => setSearch(e.target.value)} />
        {(matches.data ?? []).map((b) => (
          <div key={b.id} className="flex flex-wrap items-center gap-2">
            <span className="w-56">
              {b.customer_name} <span className="text-xs text-slate-500">{b.ctdms_order_booking_no} · {b.status.replace(/_/g, " ")}</span>
            </span>
            <ActionForm
              tone="danger"
              label="Withdraw DO"
              hidden={{}}
              fields={[{ name: "why", placeholder: "Reason", required: true, width: "w-36" }]}
              action={async (fd) => {
                await rpc("pool_revert_do", { p_booking_id: b.id, p_reason: str(fd, "why") });
              }}
            />
            {b.status === "ready_to_invoice" && (
              <ActionForm
                tone="light"
                label="Pull back billing"
                hidden={{}}
                fields={[
                  { name: "to", placeholder: "To", options: [{ id: "allotted", name: "Keep the car" }, { id: "pool", name: "Car back to pool" }], required: true, width: "w-36" },
                  { name: "why", placeholder: "Reason", required: true, width: "w-36" },
                ]}
                action={async (fd) => {
                  await rpc("pool_revert_from_billing", { p_booking_id: b.id, p_target: str(fd, "to"), p_reason: str(fd, "why") });
                }}
              />
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function Settings() {
  const canEdit = useRightGate("stock_pool_config", "edit");
  const cfg = useQuery(async () => must(await supabase.from("pool_config").select("next_in_line_size").single()) as { next_in_line_size: number }, []);
  const variants = useQuery(async () => must(await supabase.from("variants").select("id, name, tkm_suffix_code, pool_manual_only").eq("is_active", true).order("name")) as { id: string; name: string; tkm_suffix_code: string | null; pool_manual_only: boolean }[], []);
  return (
    <>
      <Card title="Next in line">
        <div className="px-3 py-2">
          {canEdit ? (
            <ActionForm
              label="Save"
              hidden={{}}
              fields={[{ name: "n", placeholder: "Customers shown", type: "number", required: true, width: "w-32", initial: String(cfg.data?.next_in_line_size ?? 3) }]}
              action={async (fd) => {
                await rpc("pool_set_next_in_line_size", { p_size: Number(str(fd, "n")) });
                cfg.reload();
              }}
            />
          ) : (
            <p className="text-sm">{cfg.data?.next_in_line_size} customers shown per variant and colour.</p>
          )}
        </div>
      </Card>
      <Card title="Manual-only variants" note="Their cars stay out of the pool and its lists; allot them by hand.">
        <Loaded q={variants}>
          {(rows) => (
            <div className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {rows.map((v) => (
                <label key={v.id} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    disabled={!canEdit}
                    checked={v.pool_manual_only}
                    onChange={() => rpc("set_variant_pool_manual_only", { p_variant_id: v.id, p_on: !v.pool_manual_only }).then(() => variants.reload()).catch((e) => alert(e.message))}
                  />
                  {v.name} <span className="text-slate-400">{v.tkm_suffix_code}</span>
                </label>
              ))}
            </div>
          )}
        </Loaded>
      </Card>
    </>
  );
}
