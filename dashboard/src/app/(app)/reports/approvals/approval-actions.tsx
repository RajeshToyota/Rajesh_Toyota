"use client";

import { useState, useTransition } from "react";
import { decideApproval } from "./actions";

export function ApprovalActions({ approvalId }: { approvalId: string }) {
  const [comment, setComment] = useState("");
  const [pending, startTransition] = useTransition();

  function submit(decision: "approved" | "rejected") {
    const formData = new FormData();
    formData.set("approval_id", approvalId);
    formData.set("decision", decision);
    formData.set("comment", comment);
    startTransition(() => {
      decideApproval(formData);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Comment (optional)"
        className="rounded-md border border-slate-300 px-2 py-1 text-xs"
      />
      <div className="flex gap-2">
        <button
          disabled={pending}
          onClick={() => submit("approved")}
          className="rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          Approve
        </button>
        <button
          disabled={pending}
          onClick={() => submit("rejected")}
          className="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          Reject
        </button>
      </div>
    </div>
  );
}
