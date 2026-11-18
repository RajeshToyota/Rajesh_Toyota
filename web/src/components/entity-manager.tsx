"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { EntityConfig, FieldConfig } from "@/lib/entities";
import { parseCsv } from "@/lib/csv";

type Row = Record<string, unknown>;
type OptionMap = Record<string, { value: string; label: string }[]>;

type SortState = { key: string; dir: "asc" | "desc" } | null;

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const norm = (s: string) => s.trim().toLowerCase();

function parseBool(raw: string): boolean | null {
  const v = norm(raw);
  if (["yes", "y", "true", "1"].includes(v)) return true;
  if (["no", "n", "false", "0"].includes(v)) return false;
  return null;
}

function emptyForm(fields: FieldConfig[]): Row {
  const form: Row = {};
  for (const f of fields) {
    form[f.key] = f.type === "boolean" ? false : "";
  }
  return form;
}

export function EntityManager({ config, canWrite }: { config: EntityConfig; canWrite: boolean }) {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Row[]>([]);
  const [options, setOptions] = useState<OptionMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Row>(() => emptyForm(config.fields));
  const [saving, setSaving] = useState(false);
  const [sort, setSort] = useState<SortState>(null);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const fkFields = useMemo(
    () => config.fields.filter((f) => f.type === "foreign_key"),
    [config.fields],
  );

  async function loadRows() {
    setLoading(true);
    setError(null);
    let query = supabase.from(config.table).select("*");
    if (config.orderBy) query = query.order(config.orderBy);
    const { data, error } = await query;
    if (error) setError(error.message);
    setRows(data ?? []);
    setLoading(false);
  }

  async function loadOptions() {
    // Fetch every foreign-key field's options in parallel — this was previously a sequential
    // for-of loop, so a table with N foreign keys paid N round-trips back to back instead of
    // the cost of the slowest one. Especially costly with the app on Vercel and the database on
    // a different Supabase region, where each round-trip carries real cross-region latency.
    const entries = await Promise.all(
      fkFields
        .filter((f) => f.foreignTable)
        .map(async (f) => {
          const labelKey = f.foreignLabelKey ?? "name";
          const { data } = await supabase.from(f.foreignTable!).select("*");
          const options = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
            value: r.id as string,
            label: String(r[labelKey] ?? r.id),
          }));
          return [f.key, options] as const;
        }),
    );
    setOptions(Object.fromEntries(entries));
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount/change
    setSort(null);
    setNotice(null);
    void loadRows();
    void loadOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.slug]);

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm(config.fields));
    setFormOpen(true);
  }

  function openEdit(row: Row) {
    setEditingId(row.id as string);
    const next: Row = {};
    for (const f of config.fields) {
      next[f.key] = row[f.key] ?? (f.type === "boolean" ? false : "");
    }
    setForm(next);
    setFormOpen(true);
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this record? This cannot be undone.")) return;
    const { error } = await supabase.from(config.table).delete().eq("id", id);
    if (error) {
      alert(`Could not delete: ${error.message}`);
      return;
    }
    loadRows();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const payload: Row = {};
    for (const f of config.fields) {
      const v = form[f.key];
      if (f.type === "number") {
        payload[f.key] = v === "" || v === null ? null : Number(v);
      } else if (f.type === "foreign_key") {
        payload[f.key] = v === "" ? null : v;
      } else if (f.type === "date") {
        payload[f.key] = v === "" ? null : v;
      } else if (f.type === "text_array") {
        const parts = String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        payload[f.key] = parts.length > 0 ? parts : null;
      } else {
        payload[f.key] = v;
      }
    }

    const { error } = editingId
      ? await supabase.from(config.table).update(payload).eq("id", editingId)
      : await supabase.from(config.table).insert(payload);

    setSaving(false);

    if (error) {
      setError(error.message);
      return;
    }

    setFormOpen(false);
    loadRows();
  }

  function labelFor(field: FieldConfig, value: unknown): string {
    if (value === null || value === undefined || value === "") return "—";
    if (field.type === "foreign_key") {
      return options[field.key]?.find((o) => o.value === value)?.label ?? String(value);
    }
    if (field.type === "boolean") return value ? "Yes" : "No";
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  }

  const tableFields = config.fields.filter((f) => !f.hideInTable);

  function toggleSort(key: string) {
    setSort((prev) =>
      prev?.key !== key ? { key, dir: "asc" } : { key, dir: prev.dir === "asc" ? "desc" : "asc" },
    );
  }

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const field = config.fields.find((f) => f.key === sort.key);
    if (!field) return rows;
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    const sortValue = (row: Row): string | number | null => {
      const v = row[field.key];
      if (v === null || v === undefined || v === "") return null;
      if (field.type === "number") return Number(v);
      if (field.type === "boolean") return v ? 1 : 0;
      if (field.type === "foreign_key") return labelFor(field, v);
      if (field.type === "select") return field.options?.find((o) => o.value === v)?.label ?? String(v);
      return Array.isArray(v) ? v.join(", ") : String(v);
    };
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = sortValue(a);
      const bv = sortValue(b);
      // Blanks always sink to the bottom, whichever direction.
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : collator.compare(String(av), String(bv));
      return cmp * factor;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort, options, config.fields]);

  // ---- Export: every field (hidden ones too) plus the row id, so the same file can be edited in
  // Excel and imported back as updates. Foreign keys are written as their readable label.
  function exportValue(field: FieldConfig, value: unknown): string {
    if (value === null || value === undefined) return "";
    if (field.type === "foreign_key") {
      return options[field.key]?.find((o) => o.value === value)?.label ?? String(value);
    }
    if (field.type === "boolean") return value ? "Yes" : "No";
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  }

  function handleExport() {
    const header = ["id", ...config.fields.map((f) => f.label)];
    const lines = [header.map(csvCell).join(",")];
    for (const row of sortedRows) {
      const cells = [String(row.id ?? ""), ...config.fields.map((f) => exportValue(f, row[f.key]))];
      lines.push(cells.map(csvCell).join(","));
    }
    // BOM so Excel opens UTF-8 correctly.
    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${config.slug}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- Import: rows with an id update that record; rows with a blank id are inserted.
  // Columns are matched by field label or key (case-insensitive); missing columns are left alone.
  async function handleImportFile(file: File) {
    setError(null);
    setNotice(null);
    const text = (await file.text()).replace(/^\uFEFF/, "");
    const grid = parseCsv(text);
    if (grid.length < 2) {
      setError("The file has no data rows.");
      return;
    }
    const header = grid[0].map(norm);
    const idCol = header.indexOf("id");
    const colFor = new Map<string, number>();
    for (const f of config.fields) {
      const i = header.findIndex((h) => h === norm(f.label) || h === norm(f.key));
      if (i >= 0) colFor.set(f.key, i);
    }
    if (colFor.size === 0) {
      setError("No column in the file matches this table. Export first to get the right headers.");
      return;
    }

    const existingIds = new Set(rows.map((r) => String(r.id)));
    const inserts: Row[] = [];
    const updates: Row[] = [];
    const problems: string[] = [];

    grid.slice(1).forEach((cells, idx) => {
      const line = idx + 2;
      const id = idCol >= 0 ? (cells[idCol] ?? "").trim() : "";
      if (id && !existingIds.has(id)) {
        problems.push(`Row ${line}: id ${id} does not exist here (clear the id to add it as new).`);
        return;
      }
      const payload: Row = {};
      for (const f of config.fields) {
        const col = colFor.get(f.key);
        if (col === undefined) {
          if (!id && f.required) problems.push(`Row ${line}: column "${f.label}" is required.`);
          continue;
        }
        const raw = (cells[col] ?? "").trim();
        if (raw === "") {
          if (f.required) problems.push(`Row ${line}: "${f.label}" is required.`);
          // Blank cells save as null, same as the form. An empty string would collide on
          // partial unique indexes such as variants.tkm_suffix_code (unique where not null).
          payload[f.key] = f.type === "boolean" ? false : null;
          continue;
        }
        switch (f.type) {
          case "number": {
            const n = Number(raw.replace(/,/g, ""));
            if (Number.isNaN(n)) problems.push(`Row ${line}: "${f.label}" must be a number (got "${raw}").`);
            payload[f.key] = n;
            break;
          }
          case "boolean": {
            const b = parseBool(raw);
            if (b === null) problems.push(`Row ${line}: "${f.label}" must be Yes or No (got "${raw}").`);
            payload[f.key] = b ?? false;
            break;
          }
          case "foreign_key": {
            const match = options[f.key]?.find((o) => norm(o.label) === norm(raw) || o.value === raw);
            if (!match) problems.push(`Row ${line}: "${f.label}" has no match for "${raw}".`);
            payload[f.key] = match?.value ?? null;
            break;
          }
          case "select": {
            const match = f.options?.find((o) => norm(o.value) === norm(raw) || norm(o.label) === norm(raw));
            if (!match) problems.push(`Row ${line}: "${f.label}" has no option "${raw}".`);
            payload[f.key] = match?.value ?? null;
            break;
          }
          case "date": {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) problems.push(`Row ${line}: "${f.label}" must be YYYY-MM-DD (got "${raw}").`);
            payload[f.key] = raw;
            break;
          }
          case "text_array":
            payload[f.key] = raw.split(",").map((s) => s.trim()).filter(Boolean);
            break;
          default:
            payload[f.key] = raw;
        }
      }
      if (id) updates.push({ id, ...payload });
      else inserts.push(payload);
    });

    if (problems.length > 0) {
      const shown = problems.slice(0, 15).join("\n");
      const more = problems.length > 15 ? `\n…and ${problems.length - 15} more.` : "";
      setError(`Nothing was imported. Fix these and try again:\n${shown}${more}`);
      return;
    }
    if (inserts.length + updates.length === 0) {
      setError("The file has no data rows.");
      return;
    }
    if (!confirm(`Import ${config.title}: add ${inserts.length} new and update ${updates.length} existing record(s)?`)) {
      return;
    }

    setImporting(true);
    let failed: string | null = null;
    if (inserts.length > 0) {
      const { error } = await supabase.from(config.table).insert(inserts);
      if (error) failed = `Adding new records failed: ${error.message}`;
    }
    if (!failed && updates.length > 0) {
      const { error } = await supabase.from(config.table).upsert(updates, { onConflict: "id" });
      if (error) failed = `Updating records failed: ${error.message}`;
    }
    setImporting(false);
    if (failed) setError(failed);
    else setNotice(`Imported: ${inserts.length} added, ${updates.length} updated.`);
    loadRows();
  }

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">{config.title}</h1>
          {config.description && (
            <p className="mt-1 text-sm text-slate-500">{config.description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={handleExport}
            disabled={loading || rows.length === 0}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            Export
          </button>
          {canWrite && (
            <>
              <button
                onClick={() => fileInput.current?.click()}
                disabled={loading || importing}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              >
                {importing ? "Importing…" : "Import"}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void handleImportFile(file);
                }}
              />
              <button
                onClick={openCreate}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
              >
                + Add
              </button>
            </>
          )}
        </div>
      </div>

      {error && !formOpen && (
        <p className="mb-3 whitespace-pre-line rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}
      {notice && (
        <p className="mb-3 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">{notice}</p>
      )}

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500">No records yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                {tableFields.map((f) => (
                  <th
                    key={f.key}
                    aria-sort={sort?.key === f.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                    className="px-3 py-2 text-left font-medium text-slate-600"
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(f.key)}
                      className="inline-flex items-center gap-1 hover:text-slate-900"
                      title="Sort"
                    >
                      {f.label}
                      <span className={sort?.key === f.key ? "text-slate-900" : "text-slate-300"}>
                        {sort?.key === f.key ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </button>
                  </th>
                ))}
                {canWrite && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sortedRows.map((row) => (
                <tr key={row.id as string}>
                  {tableFields.map((f) => (
                    <td key={f.key} className="whitespace-nowrap px-3 py-2 text-slate-700">
                      {labelFor(f, row[f.key])}
                    </td>
                  ))}
                  {canWrite && (
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      <button
                        onClick={() => openEdit(row)}
                        className="mr-2 text-slate-600 hover:underline"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(row.id as string)}
                        className="text-red-600 hover:underline"
                      >
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {formOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-6 shadow-lg">
            <h2 className="text-base font-semibold text-slate-900">
              {editingId ? "Edit" : "Add"} {config.title.replace(/s$/, "")}
            </h2>

            <form onSubmit={handleSubmit} className="mt-4 space-y-3">
              {config.fields.map((f) => (
                <div key={f.key}>
                  <label className="block text-sm font-medium text-slate-700">
                    {f.label}
                    {f.required && <span className="text-red-500"> *</span>}
                  </label>

                  {f.type === "boolean" ? (
                    <input
                      type="checkbox"
                      checked={Boolean(form[f.key])}
                      onChange={(e) => setForm({ ...form, [f.key]: e.target.checked })}
                      className="mt-1.5 h-4 w-4"
                    />
                  ) : f.type === "textarea" ? (
                    <textarea
                      value={String(form[f.key] ?? "")}
                      required={f.required}
                      onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                      className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                      rows={3}
                    />
                  ) : f.type === "select" ? (
                    <select
                      value={String(form[f.key] ?? "")}
                      required={f.required}
                      onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                      className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                    >
                      <option value="">Select…</option>
                      {f.options?.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : f.type === "foreign_key" ? (
                    <select
                      value={String(form[f.key] ?? "")}
                      required={f.required}
                      onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                      className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                    >
                      <option value="">—</option>
                      {options[f.key]?.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                      step={f.step}
                      required={f.required}
                      value={String(form[f.key] ?? "")}
                      onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                      className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                    />
                  )}
                </div>
              ))}

              {error && <p className="text-sm text-red-600">{error}</p>}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setFormOpen(false)}
                  className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
