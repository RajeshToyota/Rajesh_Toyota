"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { parseCsv } from "@/lib/csv";

const REQUIRED_FIELDS = [
  { key: "variant", label: "Variant name (must match Variants exactly)" },
  { key: "color", label: "Color name (must match Colors exactly)" },
  { key: "state", label: "State" },
  { key: "ex_showroom_price", label: "Ex-Showroom Price" },
  { key: "effective_from", label: "Effective From (YYYY-MM-DD)" },
] as const;

const OPTIONAL_FIELDS = [
  { key: "dealer_purchase_price", label: "Dealer Purchase Price" },
  { key: "effective_to", label: "Effective To (YYYY-MM-DD)" },
] as const;

type FieldKey =
  | (typeof REQUIRED_FIELDS)[number]["key"]
  | (typeof OPTIONAL_FIELDS)[number]["key"];

type Step = "upload" | "map" | "preview" | "done";

type PreviewRow = {
  raw: Record<FieldKey, string>;
  variantId: string | null;
  colorId: string | null;
  status: "new" | "update" | "unchanged" | "error";
  message?: string;
  existingId?: string;
  existingPrice?: number;
};

function guessMapping(headers: string[]): Partial<Record<FieldKey, string>> {
  const mapping: Partial<Record<FieldKey, string>> = {};
  const all = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];
  for (const field of all) {
    const match = headers.find(
      (h) => h.trim().toLowerCase().replace(/[\s_]+/g, "") === field.key.replace(/_/g, ""),
    );
    if (match) mapping[field.key] = match;
  }
  return mapping;
}

export default function PriceListImportPage() {
  const supabase = useMemo(() => createClient(), []);
  const [step, setStep] = useState<Step>("upload");
  const [headers, setHeaders] = useState<string[]>([]);
  const [dataRows, setDataRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Partial<Record<FieldKey, string>>>({});
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [processing, setProcessing] = useState(false);
  const [importSummary, setImportSummary] = useState<{ inserted: number; superseded: number } | null>(null);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const rows = parseCsv(String(reader.result));
      if (rows.length < 2) return;
      const [head, ...rest] = rows;
      setHeaders(head);
      setDataRows(rest);
      setMapping(guessMapping(head));
      setStep("map");
    };
    reader.readAsText(file);
  }

  async function buildPreview() {
    setProcessing(true);

    const { data: variants } = await supabase.from("variants").select("id, name");
    const { data: colors } = await supabase.from("colors").select("id, name");
    const { data: activePrices } = await supabase
      .from("price_list")
      .select("id, variant_id, color_id, state, ex_showroom_price")
      .is("effective_to", null);

    const variantByName = new Map((variants ?? []).map((v) => [v.name.trim().toLowerCase(), v.id]));
    const colorByName = new Map((colors ?? []).map((c) => [c.name.trim().toLowerCase(), c.id]));

    const rows: PreviewRow[] = dataRows.map((cells) => {
      const raw = {} as Record<FieldKey, string>;
      for (const field of [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]) {
        const col = mapping[field.key];
        const idx = col ? headers.indexOf(col) : -1;
        raw[field.key] = idx >= 0 ? (cells[idx] ?? "").trim() : "";
      }

      const variantId = variantByName.get(raw.variant.trim().toLowerCase()) ?? null;
      const colorId = colorByName.get(raw.color.trim().toLowerCase()) ?? null;

      if (!variantId) return { raw, variantId, colorId, status: "error", message: `Unknown variant "${raw.variant}"` };
      if (!colorId) return { raw, variantId, colorId, status: "error", message: `Unknown color "${raw.color}"` };
      if (!raw.state) return { raw, variantId, colorId, status: "error", message: "Missing state" };
      if (!raw.ex_showroom_price || Number.isNaN(Number(raw.ex_showroom_price)))
        return { raw, variantId, colorId, status: "error", message: "Missing/invalid ex_showroom_price" };
      if (!raw.effective_from) return { raw, variantId, colorId, status: "error", message: "Missing effective_from" };

      const existing = (activePrices ?? []).find(
        (p) => p.variant_id === variantId && p.color_id === colorId && p.state === raw.state,
      );

      if (!existing) {
        return { raw, variantId, colorId, status: "new" };
      }

      if (Number(existing.ex_showroom_price) === Number(raw.ex_showroom_price)) {
        return { raw, variantId, colorId, status: "unchanged", existingId: existing.id, existingPrice: existing.ex_showroom_price };
      }

      return { raw, variantId, colorId, status: "update", existingId: existing.id, existingPrice: existing.ex_showroom_price };
    });

    setPreview(rows);
    setProcessing(false);
    setStep("preview");
  }

  async function confirmImport() {
    setProcessing(true);
    let inserted = 0;
    let superseded = 0;

    for (const row of preview) {
      if (row.status === "error" || row.status === "unchanged") continue;

      if (row.status === "update" && row.existingId) {
        // Close out the previous active price the day before the new one takes effect —
        // price_list is a history, never overwritten in place.
        const dayBefore = new Date(row.raw.effective_from);
        dayBefore.setDate(dayBefore.getDate() - 1);
        await supabase
          .from("price_list")
          .update({ effective_to: dayBefore.toISOString().slice(0, 10) })
          .eq("id", row.existingId);
        superseded++;
      }

      await supabase.from("price_list").insert({
        variant_id: row.variantId,
        color_id: row.colorId,
        state: row.raw.state,
        ex_showroom_price: Number(row.raw.ex_showroom_price),
        dealer_purchase_price: row.raw.dealer_purchase_price ? Number(row.raw.dealer_purchase_price) : null,
        effective_from: row.raw.effective_from,
        effective_to: row.raw.effective_to || null,
      });
      inserted++;
    }

    setImportSummary({ inserted, superseded });
    setProcessing(false);
    setStep("done");
  }

  return (
    <div className="max-w-4xl">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Import Price List from CSV</h1>
        <Link href="/admin/price-list" className="text-sm text-slate-600 hover:underline">
          ← Back to Price List
        </Link>
      </div>

      {step === "upload" && (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center">
          <p className="text-sm text-slate-600">
            Upload a CSV with columns for variant, color, state, ex-showroom price, and effective
            date. Column names don&apos;t need to match exactly — you&apos;ll map them next.
          </p>
          <input type="file" accept=".csv" onChange={handleFile} className="mx-auto mt-4 block text-sm" />
        </div>
      )}

      {step === "map" && (
        <div className="rounded-lg border border-slate-200 bg-white p-6">
          <p className="text-sm text-slate-500">{dataRows.length} rows found. Map each field to a CSV column.</p>
          <div className="mt-4 space-y-3">
            {[...REQUIRED_FIELDS, ...OPTIONAL_FIELDS].map((field) => (
              <div key={field.key} className="grid grid-cols-2 items-center gap-3">
                <label className="text-sm text-slate-700">
                  {field.label}
                  {REQUIRED_FIELDS.some((f) => f.key === field.key) && <span className="text-red-500"> *</span>}
                </label>
                <select
                  value={mapping[field.key] ?? ""}
                  onChange={(e) => setMapping({ ...mapping, [field.key]: e.target.value || undefined })}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                >
                  <option value="">— Not mapped —</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <button onClick={() => setStep("upload")} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100">
              Back
            </button>
            <button
              onClick={buildPreview}
              disabled={processing || REQUIRED_FIELDS.some((f) => !mapping[f.key])}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {processing ? "Resolving…" : "Preview"}
            </button>
          </div>
        </div>
      )}

      {step === "preview" && (
        <div className="rounded-lg border border-slate-200 bg-white p-6">
          <div className="mb-3 flex gap-4 text-sm">
            <span className="text-emerald-700">{preview.filter((r) => r.status === "new").length} new</span>
            <span className="text-amber-700">{preview.filter((r) => r.status === "update").length} price changes</span>
            <span className="text-slate-500">{preview.filter((r) => r.status === "unchanged").length} unchanged</span>
            <span className="text-red-700">{preview.filter((r) => r.status === "error").length} errors</span>
          </div>

          <div className="max-h-96 overflow-y-auto rounded-md border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">Variant</th>
                  <th className="px-3 py-2 text-left">Color</th>
                  <th className="px-3 py-2 text-left">State</th>
                  <th className="px-3 py-2 text-left">New Price</th>
                  <th className="px-3 py-2 text-left">Old Price</th>
                  <th className="px-3 py-2 text-left">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {preview.map((row, i) => (
                  <tr key={i}>
                    <td className="px-3 py-1.5">
                      <span
                        className={
                          row.status === "new"
                            ? "text-emerald-700"
                            : row.status === "update"
                              ? "text-amber-700"
                              : row.status === "error"
                                ? "text-red-700"
                                : "text-slate-400"
                        }
                      >
                        {row.status}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">{row.raw.variant}</td>
                    <td className="px-3 py-1.5">{row.raw.color}</td>
                    <td className="px-3 py-1.5">{row.raw.state}</td>
                    <td className="px-3 py-1.5">{row.raw.ex_showroom_price}</td>
                    <td className="px-3 py-1.5">{row.existingPrice ?? "—"}</td>
                    <td className="px-3 py-1.5 text-red-600">{row.message ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <button onClick={() => setStep("map")} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100">
              Back
            </button>
            <button
              onClick={confirmImport}
              disabled={processing || preview.every((r) => r.status === "error" || r.status === "unchanged")}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {processing ? "Importing…" : "Confirm Import"}
            </button>
          </div>
        </div>
      )}

      {step === "done" && importSummary && (
        <div className="rounded-lg border border-slate-200 bg-white p-6">
          <p className="text-sm text-slate-700">
            Imported {importSummary.inserted} new price row(s), superseding {importSummary.superseded}{" "}
            previous active row(s).
          </p>
          <Link href="/admin/price-list" className="mt-4 inline-block rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800">
            View Price List
          </Link>
        </div>
      )}
    </div>
  );
}
