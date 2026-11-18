import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { saveNewEmployee } from "../actions";
import { RecordForm } from "../record-form";
import { SALARY_INPUTS, canManageHr, employeeInputs } from "../shared";
import { staffOptions } from "../options";

export default async function NewEmployeePage() {
  const employee = await getCurrentEmployee();
  if (!canManageHr(employee)) return <p className="text-sm text-slate-600">Only HR or the Business Head can add employees.</p>;
  const supabase = await createClient();
  const { roles, outlets, managers } = await staffOptions(supabase, employee);

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <Link href="/hr" className="text-sm text-slate-500 underline">
          ← Employees
        </Link>
        <h1 className="mt-1 text-lg font-semibold text-slate-900">Add employee</h1>
        <p className="text-sm text-slate-500">
          The onboarding checklist starts straight away. Salary, ESI and PF are visible only to HR, the Business Head and the employee. Send the CRM login from their page once the work email is in.
        </p>
      </div>
      <section className="rounded-md border border-slate-200 bg-white p-4">
        <RecordForm
          inputs={[...employeeInputs(roles, outlets, managers), ...SALARY_INPUTS]}
          initial={{}}
          hidden={{}}
          action={saveNewEmployee}
          submitLabel="Add employee"
          redirectPrefix="/hr/"
        />
      </section>
    </div>
  );
}
