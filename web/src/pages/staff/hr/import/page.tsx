import { getCurrentEmployee } from "@/lib/auth";
import { canManageHr } from "../shared";
import EmployeePrivateImport from "./employee-private-import";

export default async function HrImportPage() {
  const employee = await getCurrentEmployee();
  if (!canManageHr(employee)) {
    return <p className="text-sm text-red-700">Only HR or the Business Head can use the employee private-data importer.</p>;
  }
  return <EmployeePrivateImport />;
}
