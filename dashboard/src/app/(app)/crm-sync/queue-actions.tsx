"use client";

import { useState, useTransition } from "react";
import { createEnquiriesFromCtdms, createEnquiryFromCtdms, markBookingEntered, markEnquiryEntered } from "./actions";

type Option = { id: string; name: string };

function useAction() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (action: (fd: FormData) => Promise<void>, fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v) fd.set(k, v);
    setError(null);
    startTransition(async () => {
      try {
        await action(fd);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong");
      }
    });
  };
  return { pending, error, run };
}

// "Done" for an enquiry typed into CTDMS. The CTDMS number is optional: the next report
// matches on mobile number anyway.
export function EnquiryDone({ enquiryId }: { enquiryId: string }) {
  const { pending, error, run } = useAction();
  const [no, setNo] = useState("");
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1">
        <input
          value={no}
          onChange={(e) => setNo(e.target.value)}
          placeholder="CTDMS enquiry no. (optional)"
          className="w-44 rounded-md border border-slate-300 px-2 py-1 text-xs"
        />
        <button
          disabled={pending}
          onClick={() => run(markEnquiryEntered, { enquiry_id: enquiryId, ctdms_no: no })}
          className="rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
        >
          Done
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

// "Done" for a booking entered in CTDMS: the order number is what the next listing matches on.
export function BookingDone({ bookingId }: { bookingId: string }) {
  const { pending, error, run } = useAction();
  const [no, setNo] = useState("");
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1">
        <input
          value={no}
          onChange={(e) => setNo(e.target.value)}
          placeholder="ORD…"
          className="w-36 rounded-md border border-slate-300 px-2 py-1 text-xs"
        />
        <button
          disabled={pending || !no.trim()}
          onClick={() => run(markBookingEntered, { booking_id: bookingId, ctdms_no: no })}
          className="rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
        >
          Done
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

// Create our enquiry from a CTDMS one. Assignee and model default to what CTDMS says; they only
// need choosing when CTDMS's Sales Officer or model isn't set up here.
export function CreateFromCtdms({
  rowId,
  needsEmployee,
  needsModel,
  employees,
  models,
}: {
  rowId: string;
  needsEmployee: boolean;
  needsModel: boolean;
  employees: Option[];
  models: Option[];
}) {
  const { pending, error, run } = useAction();
  const [employeeId, setEmployeeId] = useState("");
  const [modelId, setModelId] = useState("");
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1">
        {needsEmployee && (
          <select
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs"
          >
            <option value="">Assign to…</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        )}
        {needsModel && (
          <select
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs"
          >
            <option value="">Model…</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
        <button
          disabled={pending || (needsEmployee && !employeeId) || (needsModel && !modelId)}
          onClick={() => run(createEnquiryFromCtdms, { row_id: rowId, employee_id: employeeId, model_id: modelId })}
          className="rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
        >
          Create in our CRM
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

// Creates every Missing row that needs no choice in one go. Rows needing an assignee or model
// (or with no valid mobile) stay in the list for the per-row button.
export function BulkCreateFromCtdms({ rowIds, skipped }: { rowIds: string[]; skipped: number }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ created: number; failed: { ctdmsNo: string; message: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const go = () => {
    if (!confirm(`Create ${rowIds.length} enquiries in our CRM from CTDMS?`)) return;
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        setResult(await createEnquiriesFromCtdms(rowIds));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong");
      }
    });
  };
  return (
    <div className="flex flex-col gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <button
          disabled={pending || rowIds.length === 0}
          onClick={go}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {pending ? `Creating ${rowIds.length}…` : `Create all ${rowIds.length} in our CRM`}
        </button>
        <span className="text-xs text-slate-500">
          {rowIds.length === 0 ? "No row is ready for bulk create." : "Assigned to their CTDMS Sales Officer, model from CTDMS."}
          {skipped ? ` ${skipped} need an assignee, model or mobile first and are left below.` : ""}
        </span>
      </div>
      {result && (
        <div className="text-xs">
          <span className="text-emerald-700">Created {result.created}.</span>
          {result.failed.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-red-600">
              {result.failed.map((f) => (
                <li key={f.ctdmsNo}>{f.ctdmsNo}: {f.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
