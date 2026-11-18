interface Option {
  id: string;
  name: string;
}

export function ReportFilterBar({
  outlets,
  employees,
  values,
  extra,
}: {
  outlets: Option[];
  employees: Option[];
  values: { outlet_id?: string; employee_id?: string; from?: string; to?: string; status?: string };
  extra?: { name: string; label: string; options: Option[] }[];
}) {
  return (
    <form className="mb-4 flex flex-wrap items-end gap-3 rounded-md border border-slate-200 bg-white p-3">
      <div>
        <label className="block text-xs font-medium text-slate-500">Outlet</label>
        <select name="outlet_id" defaultValue={values.outlet_id ?? ""} className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm">
          <option value="">All outlets</option>
          {outlets.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-500">Employee</label>
        <select name="employee_id" defaultValue={values.employee_id ?? ""} className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm">
          <option value="">All employees</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-500">From</label>
        <input type="date" name="from" defaultValue={values.from ?? ""} className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-500">To</label>
        <input type="date" name="to" defaultValue={values.to ?? ""} className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
      </div>

      {extra?.map((field) => (
        <div key={field.name}>
          <label className="block text-xs font-medium text-slate-500">{field.label}</label>
          <select
            name={field.name}
            defaultValue={(values as Record<string, string | undefined>)[field.name] ?? ""}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">All</option>
            {field.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      ))}

      <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800">
        Filter
      </button>
    </form>
  );
}
