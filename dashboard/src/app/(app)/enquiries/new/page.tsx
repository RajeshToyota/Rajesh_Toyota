import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { ASSIGN_MAX_RANK } from "@/lib/enquiries";
import { EnquiryForm } from "../enquiry-form";

export default async function NewEnquiryPage() {
  const supabase = await createClient();
  const employee = await getCurrentEmployee();
  const canAssign = employee?.roleRank != null && employee.roleRank <= ASSIGN_MAX_RANK;

  const [{ data: models }, { data: variants }, { data: staff }] = await Promise.all([
    supabase.from("models").select("id, name").eq("is_active", true).order("name"),
    supabase.from("variants").select("model_id, fuel_type_id, fuel_types(name)").eq("is_active", true),
    canAssign
      ? supabase.from("employees").select("id, name, outlets(name), roles(rank)").eq("is_active", true).order("name")
      : Promise.resolve({ data: [] as never[] }),
  ]);

  // Fuels each model is actually offered in, from its active variants.
  const fuelsByModel: Record<string, { id: string; name: string }[]> = {};
  for (const v of variants ?? []) {
    const fuel = Array.isArray(v.fuel_types) ? v.fuel_types[0] : v.fuel_types;
    if (!v.fuel_type_id || !fuel) continue;
    const list = (fuelsByModel[v.model_id] ??= []);
    if (!list.some((f) => f.id === v.fuel_type_id)) list.push({ id: v.fuel_type_id, name: fuel.name });
  }

  // Consultants and team leaders the caller can see (RLS); the RPC re-checks the hierarchy.
  const team = (staff ?? [])
    .filter((e) => {
      const role = Array.isArray(e.roles) ? e.roles[0] : e.roles;
      return role && employee?.roleRank != null && role.rank >= employee.roleRank;
    })
    .map((e) => {
      const outlet = Array.isArray(e.outlets) ? e.outlets[0] : e.outlets;
      return { id: e.id, name: `${e.name}${outlet ? ` — ${outlet.name}` : ""}` };
    });

  return (
    <div>
      <h1 className="mb-1 text-lg font-semibold text-slate-900">New enquiry</h1>
      <p className="mb-6 text-sm text-slate-500">
        Every sale starts here. The enquiry is assigned to a consultant and later matched with Toyota&apos;s CRM.
      </p>
      <EnquiryForm
        models={models ?? []}
        fuelsByModel={fuelsByModel}
        team={team}
        currentEmployeeId={employee?.id ?? ""}
      />
    </div>
  );
}
