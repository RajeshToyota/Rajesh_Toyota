import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { parseCsv } from "@/lib/csv";
import { Card, Chip, EmptyRow, ErrorBox, Loaded, PageHeader, RunButton, Table, Td, fmtDate, inputCls, rpc, rpcRows } from "@/ui";

type Match = {
  booking_id: string;
  customer_name: string;
  outlet: string;
  model: string | null;
  variant: string | null;
  color: string | null;
  days_waiting: number;
  queue_position: number;
  free_cars: number;
  dealer_name: string;
  dealer_city: string | null;
  dealer_contact: string | null;
  quantity: number;
  offer_note: string | null;
  reported_on: string;
};
type Stock = { id: string; dealer_name: string; city: string | null; suffix_code: string | null; color_code: string | null; variant_id: string | null; color_id: string | null; quantity: number; reported_on: string; variants: { name: string } | null; colors: { name: string } | null };

// Techwheels' other dealers' stock, for Toyota: upload what other dealers offer (suffix and colour code
// as CTDMS prints them) and see which waiting customers it could serve.
export default function OtherDealers() {
  const matches = useQuery(() => rpcRows<Match>("vna_other_dealer_matches", { p_outlet_id: null }), []);
  const stock = useQuery(
    async () => must(await supabase.from("other_dealer_stock").select("id, dealer_name, city, suffix_code, color_code, variant_id, color_id, quantity, reported_on, variants(name), colors(name)").order("dealer_name")) as unknown as Stock[],
    [],
  );
  const canUpload = useRightGate("other_dealers", "create");
  return (
    <div>
      <PageHeader title="Other Dealers' Stock" note="Cars other Toyota dealers can transfer, matched to our customers waiting beyond free stock (VNA)." />
      <Card title={`Waiting customers they could serve (${matches.data?.length ?? 0})`}>
        <Loaded q={matches}>
          {(rows) => (
            <Table head={["Customer", "Car", "Waiting", "Dealer", "Offer"]}>
              {rows.length === 0 ? (
                <EmptyRow cols={5} text="No matches between VNA demand and other dealers' stock." />
              ) : (
                rows.map((m, i) => (
                  <tr key={i}>
                    <Td>
                      {m.customer_name}
                      <div className="text-xs text-slate-500">{m.outlet}</div>
                    </Td>
                    <Td>{[m.model, m.variant, m.color].filter(Boolean).join(" · ")}</Td>
                    <Td muted>
                      {m.days_waiting} days · #{m.queue_position} with {m.free_cars} free
                    </Td>
                    <Td>
                      {m.dealer_name}
                      <div className="text-xs text-slate-500">{[m.dealer_city, m.dealer_contact].filter(Boolean).join(" · ")}</div>
                    </Td>
                    <Td muted>
                      {m.quantity} car{m.quantity > 1 ? "s" : ""} {m.offer_note && `· ${m.offer_note}`}
                      <div className="text-xs">as of {fmtDate(m.reported_on)}</div>
                    </Td>
                  </tr>
                ))
              )}
            </Table>
          )}
        </Loaded>
      </Card>
      {canUpload && <Upload />}
      <Card title="Uploaded stock">
        <Loaded q={stock}>
          {(rows) => (
            <Table head={["Dealer", "Suffix / colour", "Car", "Qty", "As of"]}>
              {rows.length === 0 ? (
                <EmptyRow cols={5} text="Nothing uploaded yet." />
              ) : (
                rows.map((s) => (
                  <tr key={s.id}>
                    <Td>
                      {s.dealer_name}
                      <div className="text-xs text-slate-500">{s.city}</div>
                    </Td>
                    <Td>
                      <span className="font-mono text-xs">
                        {s.suffix_code} / {s.color_code}
                      </span>
                    </Td>
                    <Td>{s.variant_id && s.color_id ? `${s.variants?.name} · ${s.colors?.name}` : <Chip tone="amber">Code not recognised</Chip>}</Td>
                    <Td right>{s.quantity}</Td>
                    <Td muted>{fmtDate(s.reported_on)}</Td>
                  </tr>
                ))
              )}
            </Table>
          )}
        </Loaded>
      </Card>
    </div>
  );
}

function Upload() {
  const [dealer, setDealer] = useState({ name: "", code: "", city: "", contact: "" });
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card title="Upload a dealer's list" note="CSV with columns suffix_code, color_code and optionally vin, quantity, offer_note. Uploading again replaces that dealer's list.">
      <div className="space-y-2 px-3 py-2">
        {error && <ErrorBox message={error} />}
        {msg && <p className="text-sm text-emerald-700">{msg}</p>}
        <div className="flex flex-wrap gap-2">
          {(["name", "code", "city", "contact"] as const).map((k) => (
            <input key={k} value={dealer[k]} onChange={(e) => setDealer((d) => ({ ...d, [k]: e.target.value }))} placeholder={`Dealer ${k}`} className={`${inputCls} w-44`} />
          ))}
          <input
            type="file"
            accept=".csv,text/csv"
            className="text-sm"
            onChange={async (e) => {
              setError(null);
              const file = e.target.files?.[0];
              if (!file) return;
              const grid = parseCsv(await file.text());
              const head = (grid[0] ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
              if (!head.includes("suffix_code") || !head.includes("color_code")) {
                setError("The CSV needs suffix_code and color_code columns");
                return;
              }
              setRows(grid.slice(1).filter((r) => r.some(Boolean)).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""]))));
            }}
          />
          <RunButton
            label={`Upload ${rows.length || ""} rows`}
            disabled={!rows.length || !dealer.name}
            run={async () => {
              const [r] = await rpc<{ loaded: number; unmapped: number }[]>("import_other_dealer_stock", {
                p_dealer_name: dealer.name,
                p_dealer_code: dealer.code,
                p_city: dealer.city,
                p_contact: dealer.contact,
                p_rows: rows,
              });
              setMsg(`${r.loaded} rows loaded${r.unmapped ? `, ${r.unmapped} with codes we don't recognise` : ""}.`);
              setRows([]);
            }}
          />
        </div>
      </div>
    </Card>
  );
}
