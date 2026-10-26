"use client";

import { useMemo, useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";
import { addEmployeeDocument } from "./actions";
import { DOCUMENT_KINDS } from "./shared";

const MAX_BYTES = 15 * 1024 * 1024;

// Uploads an ID copy or letter into the employee's folder of the private employee-documents bucket,
// then records it (the database checks the path belongs to this employee).
export function DocumentUpload({ employeeId }: { employeeId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [kind, setKind] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !kind) return;
    setError(null);
    setDone(false);
    if (file.size > MAX_BYTES) {
      setError("File is larger than 15 MB.");
      return;
    }
    const ext = (file.name.split(".").pop() ?? "pdf").toLowerCase().replace(/[^a-z0-9]/g, "") || "pdf";
    const path = `${employeeId}/${kind}-${Date.now()}.${ext}`;
    startTransition(async () => {
      const { error: upError } = await supabase.storage
        .from("employee-documents")
        .upload(path, file, { contentType: file.type || "application/octet-stream" });
      if (upError) {
        setError(upError.message);
        return;
      }
      const fd = new FormData();
      fd.set("employee_id", employeeId);
      fd.set("kind", kind);
      fd.set("storage_path", path);
      try {
        await addEmployeeDocument(fd);
        setDone(true);
        setKind("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save the file");
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <select value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1 text-xs">
        <option value="">Document type…</option>
        {DOCUMENT_KINDS.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
      <label className={`text-slate-700 underline ${kind ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}>
        {pending ? "Uploading…" : "Choose file"}
        <input type="file" accept="application/pdf,image/*" onChange={onFile} disabled={pending || !kind} className="hidden" />
      </label>
      {done && <span className="text-emerald-700">Saved</span>}
      {error && <p className="w-full text-xs text-red-600">{error}</p>}
    </div>
  );
}
