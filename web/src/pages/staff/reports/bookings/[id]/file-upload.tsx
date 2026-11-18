"use client";

import { useMemo, useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";

const MAX_BYTES = 15 * 1024 * 1024;

// Uploads a document into the booking's folder of the booking-documents bucket, then hands the
// stored path to a server action (which checks it belongs to this booking).
export function FileUpload({
  bookingId,
  folder,
  field,
  label,
  action,
}: {
  bookingId: string;
  folder: "insurance" | "rto";
  field: string;
  label: string;
  action: (fd: FormData) => Promise<void>;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setDone(false);
    if (file.size > MAX_BYTES) {
      setError("File is larger than 15 MB.");
      return;
    }
    const ext = (file.name.split(".").pop() ?? "pdf").toLowerCase().replace(/[^a-z0-9]/g, "") || "pdf";
    const path = `${bookingId}/${folder}/${field}-${Date.now()}.${ext}`;
    startTransition(async () => {
      const { error: upError } = await supabase.storage
        .from("booking-documents")
        .upload(path, file, { contentType: file.type || "application/octet-stream" });
      if (upError) {
        setError(upError.message);
        return;
      }
      const fd = new FormData();
      fd.set("booking_id", bookingId);
      fd.set(field, path);
      try {
        await action(fd);
        setDone(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save the file");
      }
    });
  }

  return (
    <div className="text-sm">
      <label className="cursor-pointer text-slate-700 underline">
        {pending ? "Uploading…" : label}
        <input type="file" accept="application/pdf,image/*" onChange={onFile} disabled={pending} className="hidden" />
      </label>
      {done && <span className="ml-2 text-emerald-700">Saved</span>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
