import { useMemo, useState } from "react";
import { parseCsv } from "@/lib/csv";
import { Card, Chip, EmptyRow, ErrorBox, RunButton, Table, Td, inr, rpc } from "@/ui";
import { useCanWriteMaster } from "../shared";
import { useCategories, useModels, type Line } from "./common";

// CSV columns: model, scheme, valid_from, suffixes, category, line, tkm_share, dealer_share,
// prev_my_tkm_share, prev_my_dealer_share, customer_facing. Rows with the same model + scheme +
// valid_from become one revision.
export default function Bulk() {
  const canWrite = useCanWriteMaster("schemes");
  const models = useModels();
  const [rows, setRows] = useState<string[][] | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const preview = useMemo(() => {
    if (!rows || rows.length < 2) return [];
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const col = (r: string[], k: string) => (r[head.indexOf(k)] ?? "").trim();
    const byName = new Map((models.data ?? []).map((m) => [m.name.toLowerCase(), m.id]));
    const groups = new Map<string, { model: string; model_id: string | undefined; name: string; valid_from: string; suffixes: string; lines: Line[] }>();
    for (const r of rows.slice(1)) {
      if (!r.some((c) => c.trim())) continue;
      const key = [col(r, "model"), col(r, "scheme"), col(r, "valid_from")].join("|");
      if (!groups.has(key))
        groups.set(key, {
          model: col(r, "model"),
          model_id: byName.get(col(r, "model").toLowerCase()),
          name: col(r, "scheme"),
          valid_from: col(r, "valid_from"),
          suffixes: col(r, "suffixes"),
          lines: [],
        });
      const num = (k: string) => (col(r, k) === "" ? null : Number(col(r, k)));
      groups.get(key)!.lines.push({
        line_type: col(r, "line"),
        scheme_master_code: col(r, "category") || null,
        tkm_share: num("tkm_share") ?? 0,
        dealer_share: num("dealer_share") ?? 0,
        prev_my_tkm_share: num("prev_my_tkm_share"),
        prev_my_dealer_share: num("prev_my_dealer_share"),
        is_customer_facing: !/^(n|no|false|0)$/i.test(col(r, "customer_facing")),
      });
    }
    return [...groups.values()];
  }, [rows, models.data]);

  return (
    <Card title="Bulk scheme entry" note="Columns: model, scheme, valid_from (YYYY-MM-DD), suffixes, category, line, tkm_share, dealer_share, prev_my_tkm_share, prev_my_dealer_share, customer_facing.">
      <div className="space-y-2 px-3 py-2 text-sm">
        <input
          type="file"
          accept=".csv,text/csv"
          className="text-xs"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setResult(null);
            f.text().then((t) => setRows(parseCsv(t)));
          }}
        />
        {error && <ErrorBox message={error} />}
        {result && <p className="text-sm text-emerald-700">{result}</p>}
        {preview.length > 0 && (
          <>
            <Table head={["Model", "Scheme", "From", "Suffixes", "Lines", ""]}>
              {preview.map((g, i) => (
                <tr key={i}>
                  <Td>{g.model}</Td>
                  <Td>{g.name}</Td>
                  <Td muted>{g.valid_from}</Td>
                  <Td muted>{g.suffixes || "All"}</Td>
                  <Td muted>{g.lines.map((l) => `${l.line_type || l.scheme_master_code}: ${l.tkm_share}+${l.dealer_share}`).join("; ")}</Td>
                  <Td>{g.model_id ? <Chip tone="emerald">OK</Chip> : <Chip tone="red">Unknown model</Chip>}</Td>
                </tr>
              ))}
            </Table>
            {canWrite && (
              <RunButton
                label={`Save ${preview.filter((g) => g.model_id).length} revisions`}
                run={async () => {
                  setError(null);
                  let n = 0;
                  for (const g of preview.filter((x) => x.model_id)) {
                    const scope = g.suffixes.split(/[,;]/).map((s) => s.trim().toUpperCase()).filter(Boolean);
                    try {
                      await rpc("save_scheme_revision", { p: { model_id: g.model_id, name: g.name, valid_from: g.valid_from, suffix_scope_list: scope.length ? scope : null, lines: g.lines } }, { refresh: false });
                      n++;
                    } catch (e) {
                      setError(`${g.model} / ${g.name} / ${g.valid_from}: ${e instanceof Error ? e.message : e}. ${n} saved before this row.`);
                      return;
                    }
                  }
                  setResult(`${n} revisions saved.`);
                  setRows(null);
                }}
              />
            )}
          </>
        )}
      </div>
    </Card>
  );
}
