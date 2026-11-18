import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { ActionForm } from "@/components/action-form";
import {
  issueAsset,
  offboardEmployee,
  returnAsset,
  saveEmployee,
  saveEmployeePrivate,
  sendLoginLink,
  setEmployeeTask,
  startChecklist,
} from "../actions";
import { DocumentUpload } from "../document-upload";
import { RecordForm } from "../record-form";
import { staffOptions } from "../options";
import {
  ASSET_TYPES,
  DEPARTMENTS,
  DOCUMENT_KINDS,
  PRIVATE_INPUTS,
  canManageHr,
  employeeInputs,
  fmtDate,
  label,
  one,
} from "../shared";

const todayIst = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

type Task = { id: string; kind: string; title: string; status: string; note: string | null; done_at: string | null; auto_key: string | null };
type Asset = {
  id: string;
  asset_type: string;
  description: string | null;
  serial_no: string | null;
  issued_on: string;
  returned_on: string | null;
  return_condition: string | null;
};
type Handover = { open_enquiries: number; open_quotes: number; open_bookings: number; direct_reports: number; assets_out: number };

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="rounded-md border border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Checklist({ tasks, employeeId, manage }: { tasks: Task[]; employeeId: string; manage: boolean }) {
  return (
    <ul className="divide-y divide-slate-100 text-sm">
      {tasks.map((t) => (
        <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
          <span className={t.status === "pending" ? "" : "text-slate-500"}>
            {t.status === "done" ? "✓ " : t.status === "not_applicable" ? "– " : "○ "}
            {t.title}
            {t.status === "not_applicable" && " (not needed)"}
            {t.done_at && t.status === "done" && <span className="text-xs text-slate-400"> · {fmtDate(t.done_at)}</span>}
            {t.note && <span className="text-xs text-slate-500"> · {t.note}</span>}
          </span>
          {manage &&
            (t.status === "pending" ? (
              <span className="flex gap-1">
                <ActionForm action={setEmployeeTask} hidden={{ employee_id: employeeId, task_id: t.id, status: "done" }} label="Done" />
                <ActionForm
                  action={setEmployeeTask}
                  hidden={{ employee_id: employeeId, task_id: t.id, status: "not_applicable" }}
                  label="Not needed"
                  tone="light"
                />
              </span>
            ) : (
              <ActionForm action={setEmployeeTask} hidden={{ employee_id: employeeId, task_id: t.id, status: "pending" }} label="Undo" tone="light" />
            ))}
        </li>
      ))}
    </ul>
  );
}

// One employee's file: details, login, private details, documents, checklists, assets and offboarding.
export default async function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const viewer = await getCurrentEmployee();
  const manage = canManageHr(viewer);
  const isSelf = viewer?.id === id;

  const { data: emp } = await supabase
    .from("employees")
    .select(
      "id, name, phone, email, role_id, outlet_id, reports_to_employee_id, employee_code, designation, department, date_of_birth, " +
        "joining_date, emergency_contact_name, emergency_contact_phone, ctdms_name, is_active, exit_date, exit_reason, " +
        "auth_user_id, login_invited_at, roles(name, rank), outlets(name), manager:employees!reports_to_employee_id(name)",
    )
    .eq("id", id)
    .maybeSingle();
  if (!emp) notFound();
  const e = emp as unknown as Record<string, string | null> & {
    is_active: boolean;
    roles: { name: string; rank: number } | null;
    outlets: { name: string } | null;
    manager: { name: string } | null;
  };
  const role = one(e.roles);
  const topRole = (role?.rank ?? 99) <= 1;
  const canEdit = manage && e.is_active && (!topRole || (viewer?.roleRank ?? 99) <= 1);
  const seePrivate = manage || isSelf;

  const [{ data: tasks }, { data: assets }, { data: priv }, { data: docs }, options, handover] = await Promise.all([
    supabase.from("employee_tasks").select("id, kind, title, status, note, done_at, auto_key").eq("employee_id", id).order("sort_order"),
    supabase
      .from("employee_assets")
      .select("id, asset_type, description, serial_no, issued_on, returned_on, return_condition")
      .eq("employee_id", id)
      .order("issued_on", { ascending: false }),
    seePrivate ? supabase.from("employee_private").select("*").eq("employee_id", id).maybeSingle() : Promise.resolve({ data: null }),
    seePrivate
      ? supabase.from("employee_documents").select("id, kind, storage_path, uploaded_at").eq("employee_id", id).order("uploaded_at", { ascending: false })
      : Promise.resolve({ data: [] as { id: string; kind: string; storage_path: string; uploaded_at: string }[] }),
    canEdit ? staffOptions(supabase, viewer) : Promise.resolve(null),
    manage && e.is_active && !isSelf
      ? supabase.rpc("employee_handover", { p_employee_id: id }).then((r) => (r.data as Handover[] | null)?.[0] ?? null)
      : Promise.resolve(null),
  ]);

  const links = new Map<string, string>();
  const paths = (docs ?? []).map((d) => d.storage_path);
  if (paths.length) {
    const { data: signed } = await supabase.storage.from("employee-documents").createSignedUrls(paths, 600);
    for (const s of signed ?? []) if (s.path && s.signedUrl) links.set(s.path, s.signedUrl);
  }

  const onboarding = ((tasks ?? []) as Task[]).filter((t) => t.kind === "onboarding");
  const offboarding = ((tasks ?? []) as Task[]).filter((t) => t.kind === "offboarding");
  const assetList = (assets ?? []) as Asset[];
  const today = todayIst();
  const str = (k: string) => (e[k] as string | null) ?? "";
  const initial = Object.fromEntries(
    employeeInputs([], [], []).map((i) => [i.key, str(i.key)]),
  );
  const privateInitial = Object.fromEntries(PRIVATE_INPUTS.map((i) => [i.key, (priv as Record<string, string | null> | null)?.[i.key] ?? ""]));
  const handoverTo = (options?.managers ?? []).filter((m) => m.id !== id);
  const openWork = handover ? handover.open_enquiries + handover.open_quotes + handover.open_bookings : 0;

  return (
    <div className="space-y-4">
      <div>
        <Link href="/hr" className="text-sm text-slate-500 underline">
          ← Employees
        </Link>
        <h1 className="mt-1 text-lg font-semibold text-slate-900">
          {e.name}
          {e.employee_code && <span className="ml-2 text-sm font-normal text-slate-500">{e.employee_code}</span>}
        </h1>
        <p className="text-sm text-slate-600">
          {role?.name ?? "No role"}
          {e.designation ? ` · ${e.designation}` : ""} · {one(e.outlets)?.name ?? "No branch"} · reports to {one(e.manager)?.name ?? "—"}
        </p>
        {!e.is_active && (
          <p className="mt-2 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">
            Left on {fmtDate(e.exit_date)}
            {e.exit_reason ? `: ${e.exit_reason}` : ""}. Their login no longer opens any data.
          </p>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="Details">
          {canEdit && options ? (
            <RecordForm
              inputs={employeeInputs(options.roles, options.outlets, options.managers.filter((m) => m.id !== id))}
              initial={initial}
              hidden={{ employee_id: id }}
              action={saveEmployee}
              submitLabel="Save changes"
            />
          ) : (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-slate-500">Mobile</dt>
              <dd>{e.phone ?? "—"}</dd>
              <dt className="text-slate-500">Email</dt>
              <dd>{e.email ?? "—"}</dd>
              <dt className="text-slate-500">Department</dt>
              <dd>{e.department ? label(DEPARTMENTS, e.department) : "—"}</dd>
              <dt className="text-slate-500">Joined</dt>
              <dd>{fmtDate(e.joining_date)}</dd>
              <dt className="text-slate-500">Name in CTDMS</dt>
              <dd>{e.ctdms_name ?? "—"}</dd>
              <dt className="text-slate-500">Emergency contact</dt>
              <dd>
                {e.emergency_contact_name ?? "—"} {e.emergency_contact_phone ?? ""}
              </dd>
            </dl>
          )}
        </Section>

        <div className="space-y-4">
          <Section title="CRM login">
            <p className="text-sm text-slate-700">
              {e.auth_user_id
                ? `Linked to ${e.email ?? "a login"}.`
                : e.login_invited_at
                  ? `Invite sent on ${fmtDate(e.login_invited_at)}; not accepted yet.`
                  : "No login yet."}
              {e.login_invited_at && e.auth_user_id ? ` Last link sent ${fmtDate(e.login_invited_at)}.` : ""}
            </p>
            {manage && e.is_active && (
              <div className="mt-2">
                <ActionForm
                  action={sendLoginLink}
                  hidden={{ employee_id: id }}
                  label={e.auth_user_id ? "Send set-password link" : "Send login invite"}
                  confirm={`Email a ${e.auth_user_id ? "set-password" : "login"} link to ${e.email ?? "(no email)"}?`}
                />
                <p className="mt-1 text-xs text-slate-500">
                  The link opens a page to choose a password. The same email and password work in the mobile app.
                </p>
              </div>
            )}
          </Section>

          {seePrivate && (
            <Section title="Private details" aside={<span className="text-xs text-slate-500">HR, Business Head and the employee only</span>}>
              {manage ? (
                <RecordForm
                  inputs={PRIVATE_INPUTS}
                  initial={privateInitial}
                  hidden={{ employee_id: id }}
                  action={saveEmployeePrivate}
                  submitLabel="Save private details"
                />
              ) : (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  {PRIVATE_INPUTS.map((i) => (
                    <div key={i.key} className="contents">
                      <dt className="text-slate-500">{i.label}</dt>
                      <dd>{privateInitial[i.key] || "—"}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </Section>
          )}
        </div>
      </div>

      {seePrivate && (
        <Section title="Documents" aside={manage ? <DocumentUpload employeeId={id} /> : undefined}>
          <ul className="space-y-1 text-sm">
            {(docs ?? []).length === 0 && <li className="text-slate-400">No documents yet.</li>}
            {(docs ?? []).map((d) => (
              <li key={d.id}>
                {links.get(d.storage_path) ? (
                  <a href={links.get(d.storage_path)} target="_blank" rel="noreferrer" className="underline">
                    {label(DOCUMENT_KINDS, d.kind)}
                  </a>
                ) : (
                  label(DOCUMENT_KINDS, d.kind)
                )}{" "}
                <span className="text-xs text-slate-500">· {fmtDate(d.uploaded_at)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Section
          title={`Onboarding${onboarding.length ? ` (${onboarding.filter((t) => t.status !== "pending").length}/${onboarding.length})` : ""}`}
        >
          {onboarding.length ? (
            <Checklist tasks={onboarding} employeeId={id} manage={manage} />
          ) : manage && e.is_active ? (
            <ActionForm action={startChecklist} hidden={{ employee_id: id, kind: "onboarding" }} label="Start onboarding checklist" tone="light" />
          ) : (
            <p className="text-sm text-slate-400">No checklist.</p>
          )}
        </Section>

        <Section title="Company assets">
          <ul className="divide-y divide-slate-100 text-sm">
            {assetList.length === 0 && <li className="py-1 text-slate-400">Nothing issued.</li>}
            {assetList.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span className={a.returned_on ? "text-slate-500" : ""}>
                  {label(ASSET_TYPES, a.asset_type)}
                  {a.description ? ` — ${a.description}` : ""}
                  {a.serial_no ? ` (${a.serial_no})` : ""} · issued {fmtDate(a.issued_on)}
                  {a.returned_on && ` · returned ${fmtDate(a.returned_on)}${a.return_condition ? `, ${a.return_condition}` : ""}`}
                </span>
                {manage && !a.returned_on && (
                  <ActionForm
                    action={returnAsset}
                    hidden={{ employee_id: id, asset_id: a.id }}
                    fields={[
                      { name: "returned_on", placeholder: "Returned on", type: "date", required: true, width: "w-36", initial: today },
                      { name: "condition", placeholder: "Condition", width: "w-28" },
                    ]}
                    label="Returned"
                    tone="light"
                  />
                )}
              </li>
            ))}
          </ul>
          {manage && e.is_active && (
            <div className="mt-3 border-t border-slate-100 pt-3">
              <ActionForm
                action={issueAsset}
                hidden={{ employee_id: id }}
                fields={[
                  { name: "asset_type", placeholder: "Asset…", options: ASSET_TYPES, required: true, width: "w-32" },
                  { name: "description", placeholder: "Make / model", width: "w-40" },
                  { name: "serial_no", placeholder: "Serial / SIM no.", width: "w-36" },
                  { name: "issued_on", placeholder: "Issued on", type: "date", width: "w-36", initial: today },
                ]}
                label="Issue"
              />
            </div>
          )}
        </Section>
      </div>

      {offboarding.length > 0 && (
        <Section title={`Offboarding (${offboarding.filter((t) => t.status !== "pending").length}/${offboarding.length})`}>
          <Checklist tasks={offboarding} employeeId={id} manage={manage} />
        </Section>
      )}

      {handover && canEdit && (
        <Section title="Offboard">
          <p className="mb-2 text-sm text-slate-700">
            Still with {e.name}: {handover.open_enquiries} open enquiries, {handover.open_quotes} quotes, {handover.open_bookings} bookings,{" "}
            {handover.direct_reports} direct reports and {handover.assets_out} company assets.
          </p>
          <ActionForm
            action={offboardEmployee}
            hidden={{ employee_id: id }}
            fields={[
              { name: "exit_date", placeholder: "Last working day", type: "date", required: true, width: "w-36", initial: today },
              { name: "reason", placeholder: "Reason for leaving", required: true, width: "w-64" },
              ...(openWork > 0
                ? [{ name: "handover_to", placeholder: "Hand work over to…", options: handoverTo, required: true, width: "w-64" }]
                : []),
            ]}
            label="Offboard"
            tone="danger"
            confirm={`Offboard ${e.name}? Their open work moves to the chosen colleague, their team moves to their manager, and their login stops working.`}
          />
          <p className="mt-2 text-xs text-slate-500">
            Direct reports move to {one(e.manager)?.name ?? "their manager"}. Assets still out stay on the offboarding checklist until returned.
          </p>
        </Section>
      )}
    </div>
  );
}
