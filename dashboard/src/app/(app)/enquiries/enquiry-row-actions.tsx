"use client";

import { useState, useTransition } from "react";
import { markEnquiryLost, reassignEnquiry } from "./actions";

export function EnquiryRowActions({
  enquiryId,
  assignedEmployeeId,
  team,
}: {
  enquiryId: string;
  assignedEmployeeId: string;
  // Empty when the signed-in user may not reassign (below Team Leader).
  team: { id: string; name: string }[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState("");

  function run(action: (fd: FormData) => Promise<void>, fields: Record<string, string>) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    setError(null);
    startTransition(async () => {
      try {
        await action(fd);
        setClosing(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong");
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      {team.length > 0 && (
        <select
          aria-label="Reassign"
          disabled={pending}
          value={assignedEmployeeId}
          onChange={(e) => run(reassignEnquiry, { enquiry_id: enquiryId, employee_id: e.target.value })}
          className="rounded-md border border-slate-300 px-2 py-1 text-xs"
        >
          {!team.some((t) => t.id === assignedEmployeeId) && <option value={assignedEmployeeId}>(current)</option>}
          {team.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      {closing ? (
        <div className="flex gap-1">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why lost?"
            className="w-32 rounded-md border border-slate-300 px-2 py-1 text-xs"
          />
          <button
            disabled={pending || !reason.trim()}
            onClick={() => run(markEnquiryLost, { enquiry_id: enquiryId, reason })}
            className="rounded-md bg-slate-700 px-2 py-1 text-xs text-white disabled:opacity-50"
          >
            Save
          </button>
        </div>
      ) : (
        <button onClick={() => setClosing(true)} className="text-left text-xs text-slate-500 hover:text-slate-800">
          Mark lost
        </button>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
