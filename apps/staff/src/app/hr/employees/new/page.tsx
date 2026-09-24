import { today, toIsoDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { hrFormOptions } from "@/lib/hr-options";
import { Shell } from "@/components/Shell";
import { Alert, Panel } from "@/components/ui";
import { EmployeeForm } from "../EmployeeForm";

export default async function NewEmployeePage() {
  const principal = await requireCapability("hr.employee.create");
  const options = await hrFormOptions();

  return (
    <Shell
      principal={principal}
      title="Add an employee"
      breadcrumbs={[
        { label: "Human resources" },
        { label: "Employees", href: "/hr/employees" },
        { label: "New" },
      ]}
    >
      <div className="space-y-4">
        <Alert tone="info">
          The identity card number and the bank account number are encrypted before they are
          stored, with the key held outside the database. Only the last four digits of each are
          ever shown on a screen or written to the audit trail.
        </Alert>

        <Panel title="The record">
          <EmployeeForm
            departments={options.departments}
            positions={options.positions}
            schedules={options.schedules}
            managers={options.managers}
            costCentres={options.costCentres}
            defaultJoinedOn={toIsoDate(today())}
          />
        </Panel>
      </div>
    </Shell>
  );
}
