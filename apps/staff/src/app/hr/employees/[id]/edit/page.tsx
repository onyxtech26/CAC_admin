import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import { getEmployee, today, toIsoDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { hrFormOptions } from "@/lib/hr-options";
import { Shell } from "@/components/Shell";
import { Alert, Panel } from "@/components/ui";
import { EmployeeForm } from "../../EmployeeForm";

export default async function EditEmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("hr.employee.edit");
  const { id } = await params;
  const db = await getDb();

  const employee = await getEmployee(db, id);
  if (!employee) notFound();

  const options = await hrFormOptions({ excludeEmployeeId: id });

  return (
    <Shell
      principal={principal}
      title={`Edit ${employee.fullName}`}
      breadcrumbs={[
        { label: "Human resources" },
        { label: "Employees", href: "/hr/employees" },
        { label: employee.fullName, href: `/hr/employees/${id}` },
        { label: "Edit" },
      ]}
    >
      <div className="space-y-4">
        <Alert tone="info">
          The identity card and bank account fields are blank because what is stored is ciphertext.
          Leaving them blank keeps what is there; typing in one replaces it.
        </Alert>

        <Panel title="The record">
          <EmployeeForm
            departments={options.departments}
            positions={options.positions}
            schedules={options.schedules}
            managers={options.managers}
            costCentres={options.costCentres}
            defaultJoinedOn={toIsoDate(today())}
            defaults={{
              employeeId: employee.id,
              employeeNo: employee.employeeNo,
              fullName: employee.fullName,
              preferredName: employee.preferredName ?? "",
              nricLast4: employee.nricLast4,
              nationality: employee.nationality,
              gender: employee.gender ?? "",
              maritalStatus: employee.maritalStatus ?? "",
              email: employee.email ?? "",
              phone: employee.phone ?? "",
              positionId: employee.positionId ?? "",
              departmentId: employee.departmentId ?? "",
              reportsToId: employee.reportsToId ?? "",
              costCentreId: employee.costCentreId ?? "",
              workScheduleId: employee.workScheduleId ?? "",
              employmentType: employee.employmentType,
              joinedOn: employee.joinedOn,
              probationMonths: employee.probationMonths,
              epfApplicable: employee.epfApplicable,
              socsoApplicable: employee.socsoApplicable,
              eisApplicable: employee.eisApplicable,
              pcbApplicable: employee.pcbApplicable,
              taxDependants: employee.taxDependants,
              bankName: employee.bankName ?? "",
              bankAccountLast4: employee.bankAccountLast4,
              payFrequency: employee.payFrequency,
              deviceUserId: employee.deviceUserId ?? "",
              notes: employee.notes ?? "",
            }}
          />
        </Panel>
      </div>
    </Shell>
  );
}
