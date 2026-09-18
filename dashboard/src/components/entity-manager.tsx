"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { EntityConfig, FieldConfig } from "@/lib/entities";

type Row = Record<string, unknown>;
type OptionMap = Record<string, { value: string; label: string }[]>;

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
    const next: OptionMap = {};
    for (const f of fkFields) {
      if (!f.foreignTable) continue;
      const labelKey = f.foreignLabelKey ?? "name";
      const { data } = await supabase.from(f.foreignTable).select("*");
      next[f.key] = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
        value: r.id as string,
        label: String(r[labelKey] ?? r.id),
      }));
    }
    setOptions(next);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount/change
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
    return String(value);
  }

  const tableFields = config.fields.filter((f) => !f.hideInTable);

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">{config.title}</h1>
          {config.description && (
            <p className="mt-1 text-sm text-slate-500">{config.description}</p>
          )}
        </div>
        {canWrite && (
          <button
            onClick={openCreate}
            className="shrink-0 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            + Add
          </button>
        )}
      </div>

      {error && !formOpen && (
        <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
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
                  <th key={f.key} className="px-3 py-2 text-left font-medium text-slate-600">
                    {f.label}
                  </th>
                ))}
                {canWrite && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
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
