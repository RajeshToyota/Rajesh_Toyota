"use client";

import { useActionState, useMemo, useState } from "react";
import Link from "next/link";
import { createEnquiry, type EnquiryFormState } from "./actions";
import { MODE_OPTIONS, PURPOSE_OPTIONS, SOURCE_OPTIONS, TEMPERATURE_OPTIONS } from "@/lib/enquiries";

interface Option {
  id: string;
  name: string;
}

const inputClass = "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      {children}
    </label>
  );
}

function Select({ name, options, required, placeholder, defaultValue, onChange }: {
  name: string;
  options: Option[];
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
}) {
  return (
    <select
      name={name}
      required={required}
      defaultValue={defaultValue ?? ""}
      onChange={(e) => onChange?.(e.target.value)}
      className={inputClass}
    >
      <option value="">{placeholder ?? "Select…"}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

export function EnquiryForm({
  models,
  fuelsByModel,
  team,
  currentEmployeeId,
}: {
  models: Option[];
  fuelsByModel: Record<string, Option[]>;
  // Empty when the signed-in user may not assign to others (below Team Leader).
  team: Option[];
  currentEmployeeId: string;
}) {
  const [state, formAction, pending] = useActionState<EnquiryFormState, FormData>(createEnquiry, { error: null });
  const [modelId, setModelId] = useState("");
  const fuels = useMemo(() => fuelsByModel[modelId] ?? [], [fuelsByModel, modelId]);

  return (
    <form action={formAction} className="max-w-3xl space-y-6">
      <section className="rounded-md border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Customer</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Mobile number *">
            <input name="mobile" required inputMode="tel" placeholder="10-digit mobile" className={inputClass} />
          </Field>
          <Field label="Name *">
            <input name="name" required className={inputClass} />
          </Field>
          <Field label="Email">
            <input name="email" type="email" className={inputClass} />
          </Field>
          <Field label="PIN code">
            <input name="pin" inputMode="numeric" maxLength={6} className={inputClass} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Address">
              <input name="address" className={inputClass} />
            </Field>
          </div>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          A returning customer is matched on mobile number; their existing details are kept.
        </p>
      </section>

      <section className="rounded-md border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Interest</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Purpose of visit *">
            <Select name="purpose_of_visit" options={PURPOSE_OPTIONS} required defaultValue="new_purchase" />
          </Field>
          <Field label="Model *">
            <Select name="model_id" options={models} required onChange={setModelId} />
          </Field>
          <Field label="Fuel">
            <Select name="fuel_type_id" options={fuels} placeholder={modelId ? "Any" : "Pick a model first"} />
          </Field>
        </div>
      </section>

      <section className="rounded-md border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Source & follow-up</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Mode *">
            <Select name="mode" options={MODE_OPTIONS} required defaultValue="Walk-in" />
          </Field>
          <Field label="Source">
            <Select name="source_desc" options={SOURCE_OPTIONS} placeholder="—" />
          </Field>
          <Field label="Temperature *">
            <Select name="temperature" options={TEMPERATURE_OPTIONS} required defaultValue="WRM" />
          </Field>
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" name="test_drive_given" className="h-4 w-4" />
          Test drive given
        </label>
        <div className="mt-4">
          <Field label="Notes">
            <textarea name="notes" rows={3} placeholder="Budget, exchange vehicle, timeline…" className={inputClass} />
          </Field>
        </div>
      </section>

      {team.length > 0 && (
        <section className="rounded-md border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Assign</h2>
          <Field label="Sales Consultant">
            <Select name="assigned_employee_id" options={team} defaultValue={currentEmployeeId} required />
          </Field>
          <p className="mt-2 text-xs text-slate-500">The enquiry goes to the consultant&apos;s branch.</p>
        </section>
      )}

      {state.error && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save enquiry"}
        </button>
        <Link href="/enquiries" className="text-sm text-slate-500 hover:text-slate-700">
          Cancel
        </Link>
      </div>
    </form>
  );
}
