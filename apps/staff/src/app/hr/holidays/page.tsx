import Link from "next/link";
import { getDb } from "@cac/db";
import { formatDate, listPublicHolidays, today } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, Panel, Td } from "@/components/ui";
import { HolidayForm, RemoveHoliday } from "./HolidayForms";

/**
 * The public holiday calendar.
 *
 * Deliberately empty until CAC fills it. Malaysian holidays are partly federal and
 * partly by state, they move with the lunar calendar, and which states CAC's staff
 * work in has not been stated — so seeding a list would be inventing the working
 * year. A wrong holiday makes a present employee absent and an absent one present,
 * and both reach a payslip.
 */
export default async function HolidaysPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>;
}) {
  const principal = await requireCapability("hr.org.view");
  const query = await searchParams;
  const db = await getDb();

  const currentYear = today().getUTCFullYear();
  const year = Number(query.year) || currentYear;

  const holidays = await listPublicHolidays(db, {
    from: `${year}-01-01`,
    to: `${year}-12-31`,
  });

  const canManage = principal.capabilities.has("hr.holiday.manage");

  return (
    <Shell
      principal={principal}
      title="Public holidays"
      breadcrumbs={[{ label: "Human resources" }, { label: "Public holidays" }]}
    >
      <div className="space-y-4">
        {holidays.length === 0 && (
          <Alert tone="warn">
            No holidays are recorded for {year}. Nothing is seeded on purpose: Malaysian holidays are
            partly federal and partly by state, several move with the lunar calendar, and which
            states CAC&rsquo;s staff work in has not been stated. Until they are entered, attendance
            will treat a public holiday as an ordinary working day and mark people absent.
          </Alert>
        )}

        <Panel title="Year">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            {[currentYear - 1, currentYear, currentYear + 1].map((option) => (
              <Link
                key={option}
                href={`/hr/holidays?year=${option}`}
                className={`rounded-md border px-3 py-1.5 ${
                  option === year
                    ? "border-[var(--color-gold-2)] bg-[var(--color-gold-2)] font-semibold text-[var(--color-navy)]"
                    : "border-[var(--color-line-strong)] hover:bg-[var(--color-canvas)]"
                }`}
              >
                {option}
              </Link>
            ))}
          </div>
        </Panel>

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Panel title={`${holidays.length} in ${year}`}>
              {holidays.length === 0 ? (
                <EmptyState
                  title={`Nothing recorded for ${year}`}
                  body="Add each holiday with the gazette or circular it comes from."
                />
              ) : (
                <DataTable
                  columns={["Date", "Name", "Applies to", "Source", "", ""]}
                  caption={`Public holidays in ${year}`}
                >
                  {holidays.map((holiday) => (
                    <tr key={holiday.id}>
                      <Td>{formatDate(holiday.holidayOn)}</Td>
                      <Td>
                        {holiday.name}
                        {holiday.isHalfDay && (
                          <span className="ml-1">
                            <Badge tone="info">half day</Badge>
                          </span>
                        )}
                      </Td>
                      <Td>
                        {holiday.appliesTo.length === 0 ? (
                          <span className="text-[var(--color-muted)]">everywhere</span>
                        ) : (
                          <span className="font-mono text-[11px]">
                            {holiday.appliesTo.join(", ")}
                          </span>
                        )}
                      </Td>
                      <Td>
                        <span className="text-[11px] text-[var(--color-muted)]">
                          {holiday.sourceRef ?? "—"}
                        </span>
                      </Td>
                      <Td>
                        <span className="text-[11px] text-[var(--color-muted)]">
                          {holiday.notes ?? ""}
                        </span>
                      </Td>
                      <Td>
                        {canManage && <RemoveHoliday holidayId={holiday.id} name={holiday.name} />}
                      </Td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Panel>
          </div>

          <div className="space-y-4">
            {canManage ? (
              <Panel title="Add a holiday">
                <HolidayForm defaultYear={year} />
              </Panel>
            ) : (
              <Panel title="Adding holidays">
                <p className="text-[12px] text-[var(--color-muted)]">
                  Maintaining the calendar is reserved to HR. It affects what attendance counts as a
                  working day, and through that what payroll computes.
                </p>
              </Panel>
            )}

            <Panel title="Why the source matters">
              <p className="text-[12px] text-[var(--color-muted)]">
                A holiday changes whether somebody was absent, whether a day was a rest day, and in
                Phase 7 how a day is paid. Recording where it came from means a disagreement six
                months later is settled by looking it up rather than by whoever remembers hardest.
              </p>
            </Panel>
          </div>
        </div>
      </div>
    </Shell>
  );
}
