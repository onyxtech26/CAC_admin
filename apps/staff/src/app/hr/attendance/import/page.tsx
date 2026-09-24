import { getDb } from "@cac/db";
import { listUnmappedEmployees } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Panel } from "@/components/ui";
import { AttendanceImportWizard } from "./AttendanceImportWizard";

/**
 * Importing the thumbprint device export.
 *
 * The note at the top is not boilerplate. CAC has not yet supplied a sample export
 * (Q-HR-2), so this importer is deliberately written against no particular device:
 * it reads any delimited file and the columns are mapped explicitly. That is the
 * honest way to build it without the sample, and it is also what makes it survive
 * the device being replaced.
 */
export default async function AttendanceImportPage() {
  const principal = await requireCapability("hr.attendance.import");
  const db = await getDb();
  const unmapped = await listUnmappedEmployees(db);

  return (
    <Shell
      principal={principal}
      title="Import attendance"
      breadcrumbs={[
        { label: "Human resources" },
        { label: "Attendance", href: "/hr/attendance" },
        { label: "Import" },
      ]}
    >
      <div className="space-y-4">
        <Alert tone="info">
          Nothing is written into attendance by this screen. The file is read and shown, then staged
          as a batch, and a separate confirmation writes it. A day that has already been recorded —
          for instance one corrected by hand — is never overwritten.
        </Alert>

        {unmapped.length > 0 && (
          <Alert tone="warn">
            {unmapped.length} active employee{unmapped.length === 1 ? " has" : "s have"} no device
            number mapped. Their rows will be set aside rather than guessed at by name, because two
            people can share a name and the wrong guess puts one person&rsquo;s attendance on the
            other&rsquo;s record.
          </Alert>
        )}

        <Panel title="The file">
          <AttendanceImportWizard />
        </Panel>
      </div>
    </Shell>
  );
}
