import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { Card, Chip, ErrorBox, Loaded, PageHeader, RunButton, inputCls, rpc } from "@/ui";
import { KINDS, monthLabel } from "./shared";

type Scheme = { id: string; name: string; kind: string; month_from: string; month_to: string | null; outlet_id: string | null; rules: Record<string, unknown>; is_active: boolean };

const explain = (s: Scheme) => {
  const r = s.rules as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (s.kind === "ca_retail")
    return [
      `₹${r.per_unit} a car`,
      ...(r.slabs ?? []).map((x: { min_units: number; per_unit: number }) => `₹${x.per_unit} from ${x.min_units} cars`),
      r.cap ? `cap ₹${r.cap}` : null,
      `${r.release_now_pct}% now, rest at TKM settlement`,
      `gates: ${[r.gates?.digital_checkin && "digital check-in", r.gates?.lead_checks_min && `${r.gates.lead_checks_min} lead checks`, r.gates?.assessment && "assessment"].filter(Boolean).join(", ")}`,
    ];
  if (s.kind === "tl_team") return [`${r.team_pct}% of the team's eligible CA incentive`, `${r.release_now_pct}% now`];
  if (s.kind === "gm_sm") return [`GM (${r.gm_role}) ${r.gm_pct}% : SM (${r.sm_role}) ${r.sm_pct}%`, `${r.release_now_pct}% now, rest at TKM settlement`];
  if (s.kind === "prefinance")
    return [`From ${r.min_penetration_pct}% in-house penetration (sales less cash)`, `₹${r.base_per_file} a file + ₹${r.step_per_pct} per point above`, `shared by ${r.team_role}s`, "released after the bank pays"];
  return [];
};

// The incentive SOPs as editable rules. A new version from a month keeps past runs as they were.
export default function Schemes() {
  const q = useQuery(async () => must(await supabase.from("incentive_schemes").select("*").order("kind").order("month_from", { ascending: false })) as Scheme[], []);
  const canEdit = useRightGate("incentive_schemes", "edit");
  return (
    <div>
      <PageHeader title="Incentive Schemes" note="Each scheme applies from its start month. To change an SOP, edit the rules; runs already approved keep their numbers." />
      <Loaded q={q}>{(rows) => <>{rows.map((s) => <SchemeCard key={s.id} s={s} canEdit={canEdit} />)}</>}</Loaded>
    </div>
  );
}

function SchemeCard({ s, canEdit }: { s: Scheme; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(JSON.stringify(s.rules, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <Card
      title={
        <>
          {s.name} <Chip>{KINDS[s.kind]}</Chip> {!s.is_active && <Chip tone="red">Off</Chip>}
        </>
      }
      note={`From ${monthLabel(s.month_from)}${s.month_to ? ` to ${monthLabel(s.month_to)}` : ""}${s.outlet_id ? " · one branch" : " · every branch"}`}
      aside={
        canEdit && (
          <div className="flex gap-1">
            <RunButton tone="light" label={editing ? "Close" : "Edit rules"} run={async () => setEditing(!editing)} />
            <RunButton tone="light" label={s.is_active ? "Switch off" : "Switch on"} run={() => rpc("save_incentive_scheme", { p_id: s.id, p: { is_active: !s.is_active } })} />
          </div>
        )
      }
    >
      <ul className="list-disc space-y-0.5 px-8 py-2 text-sm text-slate-700">
        {explain(s).filter(Boolean).map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
      {editing && (
        <div className="border-t border-slate-100 px-3 py-2">
          {error && <ErrorBox message={error} />}
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={14} className={`${inputCls} w-full font-mono text-xs`} />
          <RunButton
            label="Save rules"
            run={async () => {
              setError(null);
              let rules: unknown;
              try {
                rules = JSON.parse(text);
              } catch {
                setError("The rules are not valid JSON");
                return;
              }
              await rpc("save_incentive_scheme", { p_id: s.id, p: { rules } });
              setEditing(false);
            }}
          />
        </div>
      )}
    </Card>
  );
}
