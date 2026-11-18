import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useCurrentEmployee } from "@/lib/auth";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, RunButton, Table, Td, fmtDateTime, inr, num, rpc } from "@/ui";
import { stageTitle } from "./Quotes";

type Quote = {
  id: string;
  customer_name: string;
  customer_mobile: string | null;
  customer_phone: string | null;
  employee_id: string;
  outlet_id: string;
  variant_id: string;
  color_id: string;
  rto_category_id: string;
  current_stage: string;
  quantity: number;
  source: string;
  exchange_interest: boolean;
  total_amount: number | null;
  priced_snapshot: { line_items: { label: string; amount: number }[]; margin_floor_breached?: boolean; margin_available?: number; margin_used?: number } | null;
  created_at: string;
  variants: { name: string; model_id: string; tkm_suffix_code: string | null; models: { name: string } | null } | null;
  colors: { name: string } | null;
  employees: { name: string } | null;
  financiers: { name: string } | null;
};
type Version = { id: string; version_no: number; stage: string; total_amount: number; created_at: string; approvals: { status: string; comment: string | null; roles: { name: string } | null } | null };
type Booking = { id: string; status: string; fleet_unit_no: number | null; total_amount: number | null; created_at: string };
type SchemeLine = { id: string; line_type: string; tkm_share: number; dealer_share: number; is_customer_facing: boolean };

// One quote: its price, the stage it is at and its history, the next step, and its bookings.
export default function QuoteDetail() {
  const { id } = useParams();
  const me = useCurrentEmployee();
  const data = useQuery(async () => {
    const [q, versions, bookings, editable] = await Promise.all([
      supabase
        .from("quotes")
        .select("*, variants(name, model_id, tkm_suffix_code, models(name)), colors(name), employees!quotes_employee_id_fkey(name), financiers(name)")
        .eq("id", id!)
        .single(),
      supabase.from("quote_versions").select("id, version_no, stage, total_amount, created_at, approvals!quote_versions_approval_id_fkey(status, comment, roles(name))").eq("quote_id", id!).order("version_no"),
      supabase.from("bookings").select("id, status, fleet_unit_no, total_amount, created_at").eq("quote_id", id!).order("fleet_unit_no", { nullsFirst: true }),
      supabase.rpc("can_edit_quote", { p_quote_id: id }),
    ]);
    return {
      q: must(q) as unknown as Quote,
      versions: must(versions) as unknown as Version[],
      bookings: must(bookings) as Booking[],
      editable: must(editable) as { editable: boolean; reason?: string },
    };
  }, [id]);
  const [schemeIds, setSchemeIds] = useState<string[]>([]);
  const schemes = useQuery(async () => {
    const q = data.data?.q;
    if (!q?.variants) return [] as SchemeLine[];
    const today = new Date().toISOString().slice(0, 10);
    const rows = must(
      await supabase
        .from("schemes")
        .select("suffix_scope_list, scheme_line_items(id, line_type, tkm_share, dealer_share, is_customer_facing)")
        .eq("model_id", q.variants.model_id)
        .lte("valid_from", today)
        .gte("valid_to", today),
    ) as { suffix_scope_list: string[] | null; scheme_line_items: SchemeLine[] }[];
    return rows
      .filter((s) => !s.suffix_scope_list || s.suffix_scope_list.includes(q.variants?.tkm_suffix_code ?? ""))
      .flatMap((s) => s.scheme_line_items.filter((l) => l.is_customer_facing));
  }, [data.data?.q?.id]);

  return (
    <Loaded q={data}>
      {({ q, versions, bookings, editable }) => {
        const mobile = q.customer_mobile ?? q.customer_phone;
        const car = `${q.variants?.models?.name ?? ""} ${q.variants?.name ?? ""}`.trim();
        const live = bookings.filter((b) => b.status !== "cancelled");
        const message = `Dear ${q.customer_name}, thank you for booking your ${car} (${q.colors?.name}) with Rajesh Toyota.${q.quantity > 1 ? ` ${q.quantity} cars.` : ""} On-road price ${inr(q.total_amount)}${q.quantity > 1 ? " per car" : ""}.`;
        return (
          <div>
            <PageHeader
              title={`${q.customer_name} · ${car}`}
              note={
                <>
                  {q.colors?.name} · {q.employees?.name} · made on {q.source} {fmtDateTime(q.created_at)}
                  {q.quantity > 1 && ` · fleet of ${q.quantity}`}
                  {q.exchange_interest && " · has a car to exchange"}
                  {q.financiers && ` · prefers ${q.financiers.name}`}
                </>
              }
              actions={<Link to="/quotes" className="text-sm text-blue-700 hover:underline">All quotes</Link>}
            />
            {!editable.editable && editable.reason && <p className="mb-3 text-xs text-slate-500">{editable.reason}</p>}
            <div className="grid gap-4 lg:grid-cols-2">
              <Card title={`Price · ${stageTitle(q.current_stage)}`}>
                <Table head={["", ""]}>
                  {(q.priced_snapshot?.line_items ?? []).map((l, i) => (
                    <tr key={i}>
                      <Td>{l.label}</Td>
                      <Td right>{inr(l.amount)}</Td>
                    </tr>
                  ))}
                  <tr>
                    <Td className="font-semibold">On-road</Td>
                    <Td right className="font-semibold">
                      {inr(q.total_amount)}
                    </Td>
                  </tr>
                </Table>
                {q.priced_snapshot?.margin_floor_breached && (
                  <p className="mx-3 my-2 rounded bg-amber-50 p-2 text-xs text-amber-800">
                    Below the margin floor ({inr(q.priced_snapshot.margin_used)} given, {inr(q.priced_snapshot.margin_available)} available): the Business Head approves.
                  </p>
                )}
              </Card>

              <div>
                {q.current_stage !== "final" && me?.id === q.employee_id && (
                  <Card title="Next step">
                    <div className="space-y-3 px-3 py-2 text-sm">
                      {schemes.data && schemes.data.length > 0 && (
                        <div>
                          <p className="mb-1 text-xs font-medium text-slate-600">Company schemes (Team Leader approves)</p>
                          {schemes.data.map((s) => (
                            <label key={s.id} className="flex items-center gap-1">
                              <input
                                type="checkbox"
                                checked={schemeIds.includes(s.id)}
                                onChange={() => setSchemeIds(schemeIds.includes(s.id) ? schemeIds.filter((x) => x !== s.id) : [...schemeIds, s.id])}
                              />
                              {s.line_type} <span className="text-slate-400">{inr(Number(s.tkm_share) + Number(s.dealer_share))}</span>
                            </label>
                          ))}
                          <div className="mt-1">
                            <RunButton tone="light" label="Submit schemes" run={() => rpc("submit_quote_stage", { p_quote_id: q.id, p_stage: "with_schemes", p_scheme_line_item_ids: schemeIds })} />
                          </div>
                        </div>
                      )}
                      <ActionForm
                        tone="light"
                        label="Ask for dealer discount"
                        hidden={{}}
                        fields={[{ name: "amount", placeholder: "Amount", type: "number", required: true, width: "w-32" }]}
                        action={async (fd) => {
                          await rpc("submit_quote_stage", { p_quote_id: q.id, p_stage: "with_dealer_discount", p_dealer_discount: num(fd, "amount") });
                        }}
                      />
                      <RunButton label="Make final" run={() => rpc("finalize_quote", { p_quote_id: q.id })} />
                    </div>
                  </Card>
                )}

                {q.current_stage === "final" && (
                  <Card title="Bookings" note={q.quantity > 1 ? `${live.length} of ${q.quantity} cars booked` : undefined}>
                    <Table head={["Booking", "Status", "Total", ""]}>
                      {bookings.length === 0 ? (
                        <EmptyRow cols={4} text="Not booked yet." />
                      ) : (
                        bookings.map((b) => (
                          <tr key={b.id}>
                            <Td muted>
                              {b.fleet_unit_no ? `Car ${b.fleet_unit_no} · ` : ""}
                              {fmtDateTime(b.created_at)}
                            </Td>
                            <Td>
                              <Chip tone={b.status === "cancelled" ? "red" : "emerald"}>{b.status}</Chip>
                            </Td>
                            <Td right>{inr(b.total_amount)}</Td>
                            <Td>
                              <Link to={`/reports/bookings/${b.id}`} className="text-sm text-blue-700 hover:underline">
                                Open
                              </Link>
                            </Td>
                          </tr>
                        ))
                      )}
                    </Table>
                    <div className="flex flex-wrap gap-2 px-3 py-2">
                      {live.length === 0 && me?.id === q.employee_id && (
                        <ActionForm
                          label="Book"
                          hidden={{}}
                          fields={[{ name: "amount", placeholder: "Booking amount", type: "number", width: "w-36" }]}
                          action={async (fd) => {
                            must(
                              await supabase.from("bookings").insert({
                                quote_id: q.id,
                                outlet_id: q.outlet_id,
                                employee_id: q.employee_id,
                                variant_id: q.variant_id,
                                color_id: q.color_id,
                                rto_category_id: q.rto_category_id,
                                payment_amount: num(fd, "amount"),
                                status: "booked",
                              }),
                            );
                            data.reload();
                          }}
                        />
                      )}
                      {live.length > 0 && live.length < q.quantity && (
                        <RunButton
                          label={`Create the other ${q.quantity - live.length} bookings`}
                          run={async () => {
                            await rpc("expand_booking_to_fleet", { p_booking_id: live[0].id });
                            data.reload();
                          }}
                        />
                      )}
                      {mobile && live.length > 0 && (
                        <a
                          className="rounded-md border border-emerald-300 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
                          href={`https://wa.me/91${mobile.replace(/\D/g, "").slice(-10)}?text=${encodeURIComponent(message)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          WhatsApp the booking
                        </a>
                      )}
                    </div>
                  </Card>
                )}

                <Card title="History">
                  <Table head={["#", "Stage", "Total", "Approval"]}>
                    {versions.length === 0 ? (
                      <EmptyRow cols={4} text="No submissions yet." />
                    ) : (
                      versions.map((v) => (
                        <tr key={v.id}>
                          <Td muted>{v.version_no}</Td>
                          <Td>{stageTitle(v.stage)}</Td>
                          <Td right>{inr(v.total_amount)}</Td>
                          <Td muted>
                            {v.approvals ? `${v.approvals.roles?.name}: ${v.approvals.status}${v.approvals.comment ? ` (${v.approvals.comment})` : ""}` : "—"}
                          </Td>
                        </tr>
                      ))
                    )}
                  </Table>
                </Card>
              </div>
            </div>
          </div>
        );
      }}
    </Loaded>
  );
}
