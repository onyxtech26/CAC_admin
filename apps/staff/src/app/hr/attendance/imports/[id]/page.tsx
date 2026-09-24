import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import { formatDate, getAttendanceImport } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, Panel, StatTile, Td } from "@/components/ui";
import { ImportActions } from "./ImportActions";

export default async function AttendanceImportBatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const principal = await requireCapability("hr.attendance.view");
  const { id } = await params;
  const db = await getDb();

  const batch = await getAttendanceImport(db, id);
  if (!batch) notFound();

  const { summary, rows } = batch;
  const problems = rows.filter((row) => row.state === "problem" || row.state === "duplicate");
  const canImport = principal.capabilities.has("hr.attendance.import");

  return (
    <Shell
      principal={principal}
      title="Staged attendance import"
      breadcrumbs={[
        { label: "Human resources" },
        { label: "Attendance", href: "/hr/attendance" },
        { label: summary.sourceFilename ?? "Import" },
      ]}
    >
      <div className="space-y-4">
        {summary.status === "staged" && (
          <Alert tone="warn">
            Nothing here has reached attendance yet. Look at what was read, then confirm or discard
            it below.
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-4">
          <StatTile
            label="Rows read"
            value={String(summary.rowCount)}
            hint={summary.sourceFilename ?? "pasted"}
          />
          <StatTile
            label="Will import"
            value={String(summary.acceptedCount)}
            hint="one row per employee-day"
            tone="ok"
          />
          <StatTile
            label="Set aside"
            value={String(summary.rejectedCount)}
            hint={summary.rejectedCount > 0 ? "each with a reason" : "nothing rejected"}
            tone={summary.rejectedCount > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label="Covering"
            value={
              summary.periodFrom && summary.periodTo
                ? `${formatDate(summary.periodFrom)} → ${formatDate(summary.periodTo)}`
                : "—"
            }
            hint={summary.deviceLabel ?? "device not named"}
          />
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="space-y-4 xl:col-span-2">
            {problems.length > 0 && (
              <Panel
                title={`${problems.length} row${problems.length === 1 ? "" : "s"} set aside`}
                description="Kept with the reason and the original row, so a rejection can be explained by showing it."
              >
                <ul className="space-y-2 text-[12px]">
                  {problems.map((row) => (
                    <li key={row.id} className="border-b border-[var(--color-line)] pb-2 last:border-0">
                      <p>
                        <span className="font-mono text-[11px] text-[var(--color-muted)]">
                          row {row.rowNo}
                        </span>{" "}
                        {row.problem}
                      </p>
                      <p className="font-mono text-[10px] text-[var(--color-faint)]">
                        {row.raw.join(" | ")}
                      </p>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 border-t border-[var(--color-line)] pt-3 text-[11px] text-[var(--color-muted)]">
                  A row rejected because the device number is unknown is fixed by mapping that number
                  on the{" "}
                  <Link href="/hr/employees" className="text-[var(--color-info)] hover:underline">
                    employee record
                  </Link>{" "}
                  and importing the file again.
                </p>
              </Panel>
            )}

            <Panel title="What was read">
              <DataTable
                columns={["#", "Who", "Device", "Day", "In", "Out", "State"]}
                caption="Staged rows"
              >
                {rows.map((row) => (
                  <tr key={row.id}>
                    <Td>{row.rowNo}</Td>
                    <Td>
                      {row.employeeId ? (
                        <Link
                          href={`/hr/employees/${row.employeeId}`}
                          className="text-[var(--color-info)] hover:underline"
                        >
                          {row.employeeName}
                        </Link>
                      ) : (
                        <span className="text-[var(--color-faint)]">unknown</span>
                      )}
                    </Td>
                    <Td>
                      <span className="font-mono text-[11px]">{row.deviceUserId ?? "—"}</span>
                    </Td>
                    <Td>{row.workDate ? formatDate(row.workDate) : "—"}</Td>
                    <Td>{timeOf(row.clockIn)}</Td>
                    <Td>
                      {row.clockOut ? (
                        timeOf(row.clockOut)
                      ) : row.state === "ok" || row.state === "imported" ? (
                        <span className="text-[var(--color-warn)]">missing</span>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td>
                      {row.state === "imported" ? (
                        <Badge tone="ok">written</Badge>
                      ) : row.state === "ok" ? (
                        <Badge tone="info">will import</Badge>
                      ) : (
                        <Badge tone="warn">set aside</Badge>
                      )}
                    </Td>
                  </tr>
                ))}
              </DataTable>
            </Panel>
          </div>

          <div className="space-y-4">
            <Panel title="What happens next">
              {canImport ? (
                <ImportActions
                  importId={id}
                  status={summary.status}
                  acceptedCount={summary.acceptedCount}
                  rejectedCount={summary.rejectedCount}
                />
              ) : (
                <p className="text-[12px] text-[var(--color-muted)]">
                  Confirming an import is reserved to the people who may import attendance.
                </p>
              )}
            </Panel>

            <Panel title="Provenance">
              <dl className="space-y-2 text-[13px]">
                <Row label="File" value={summary.sourceFilename ?? "pasted"} />
                <Row label="Device" value={summary.deviceLabel ?? "not named"} />
                <Row label="Staged by" value={summary.createdByName ?? "—"} />
                <Row
                  label="Staged at"
                  value={new Date(summary.createdAt).toLocaleString("en-GB", {
                    timeZone: "Asia/Kuala_Lumpur",
                  })}
                />
                <Row label="Confirmed by" value={summary.confirmedByName ?? "—"} />
              </dl>
              <p className="mt-2 text-[11px] text-[var(--color-muted)]">
                Every day written from this batch points back at it, so &ldquo;where did this
                attendance come from&rdquo; has an answer for as long as the record exists.
              </p>
            </Panel>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

function timeOf(value: Date | string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kuala_Lumpur",
  });
}
