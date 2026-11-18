import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@/lib/query";
import { Card, Chip, EmptyRow, ErrorBox, Loaded, PageHeader, Table, Td, fmtDateTime, inputCls, rpcRows } from "@/ui";

type Hit = { kind: "booking" | "vehicle" | "enquiry"; id: string; title: string; subtitle: string; status: string };
type Event = { at: string; event: string; detail: string | null; by_name: string | null };

// Techwheels' search console: one box for VIN, engine no., mobile, order no. or name; a car's full timeline.
export default function Search() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const vehicle = params.get("vehicle");
  const mode = params.get("mode") ?? "all";
  const [text, setText] = useState(q);
  const [modeText, setModeText] = useState(mode);
  const hits = useQuery(() => (q.length >= 3 ? rpcRows<Hit>("search_console_mode", { p_mode: mode, p_q: q }) : Promise.resolve([] as Hit[])), [q, mode]);

  return (
    <div>
      <PageHeader title="Search Console" note="Find any booking, enquiry or car you have access to, and see a car's whole history." />
      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setParams({ q: text.trim(), mode: modeText });
        }}
      >
        <select value={modeText} onChange={(e) => setModeText(e.target.value)} className={inputCls}>
          <option value="all">Everything</option>
          <option value="vin">VIN / engine no.</option>
          <option value="mobile">Mobile / name</option>
          <option value="ctdms">CTDMS order no.</option>
          <option value="variant">Variant / suffix (stock)</option>
        </select>
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="VIN, engine no., mobile, order no. or customer name" className={`${inputCls} w-96`} />
        <button className="rounded-md bg-slate-900 px-3 py-1 text-sm text-white">Search</button>
      </form>
      {vehicle && <Timeline vehicleId={vehicle} />}
      {q && (
        <Card title={`Results for “${q}”`}>
          <Loaded q={hits}>
            {(rows) => (
              <Table head={["", "Found", "Details", "Status"]}>
                {rows.length === 0 ? (
                  <EmptyRow cols={4} text="Nothing found." />
                ) : (
                  rows.map((h) => (
                    <tr key={`${h.kind}-${h.id}`}>
                      <Td>
                        <Chip tone={h.kind === "vehicle" ? "blue" : h.kind === "booking" ? "emerald" : "slate"}>{h.kind}</Chip>
                      </Td>
                      <Td>
                        {h.kind === "booking" ? (
                          <Link to={`/reports/bookings/${h.id}`} className="font-medium hover:underline">
                            {h.title}
                          </Link>
                        ) : h.kind === "vehicle" ? (
                          <button type="button" onClick={() => setParams({ q, vehicle: h.id })} className="font-mono text-xs hover:underline">
                            {h.title}
                          </button>
                        ) : (
                          <Link to="/followups" className="hover:underline">
                            {h.title}
                          </Link>
                        )}
                      </Td>
                      <Td muted>{h.subtitle}</Td>
                      <Td>{h.status}</Td>
                    </tr>
                  ))
                )}
              </Table>
            )}
          </Loaded>
        </Card>
      )}
    </div>
  );
}

function Timeline({ vehicleId }: { vehicleId: string }) {
  const t = useQuery(() => rpcRows<Event>("vehicle_timeline", { p_vehicle_id: vehicleId }), [vehicleId]);
  if (t.error) return <ErrorBox message={t.error} />;
  return (
    <Card title="Car timeline">
      <ol className="space-y-1 px-4 py-3 text-sm">
        {(t.data ?? []).map((e, i) => (
          <li key={i} className="flex gap-3">
            <span className="w-40 shrink-0 text-xs text-slate-400">{fmtDateTime(e.at)}</span>
            <span>
              <span className="font-medium">{e.event}</span>
              {e.detail && <span className="text-slate-600"> · {e.detail}</span>}
              {e.by_name && <span className="text-xs text-slate-400"> · {e.by_name}</span>}
            </span>
          </li>
        ))}
        {t.data?.length === 0 && <li className="text-slate-400">No history.</li>}
      </ol>
    </Card>
  );
}
