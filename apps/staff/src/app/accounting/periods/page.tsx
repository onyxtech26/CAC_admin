import { getDb } from "@cac/db";
import {
  formatDate,
  getSetting,
  listFiscalYears,
  listJournals,
  listPeriods,
  today,
} from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, Panel, Td } from "@/components/ui";
import { CloseYearForm, FiscalYearForm, PeriodActions } from "./PeriodForms";

/**
 * The fiscal calendar.
 *
 * Periods are what make "the month is closed" mean something: closing one is a
 * state the database checks on every posting, not a note in a spreadsheet. The
 * screen shows how many drafts are still sitting in each period, because those
 * are what will block a close.
 */
export default async function PeriodsPage() {
  const principal = await requireCapability("accounting.period.view");
  const db = await getDb();

  const [years, periods, drafts, startMonth] = await Promise.all([
    listFiscalYears(db),
    listPeriods(db),
    listJournals(db, { status: "draft", limit: 500 }),
    getSetting<number>(db, "accounting.fiscal_year_start_month", 1),
  ]);

  const draftsByPeriod = new Map<string, number>();
  for (const draft of drafts) {
    draftsByPeriod.set(draft.periodCode, (draftsByPeriod.get(draft.periodCode) ?? 0) + 1);
  }

  const canManage = principal.capabilities.has("accounting.period.manage");
  const canLock = principal.capabilities.has("accounting.period.lock");
  const canClose = principal.capabilities.has("accounting.period.close");

  // Suggest the next year that does not exist yet, starting in the configured
  // month. It is only a default in the form; the accountant confirms it.
  const currentYear = today().getUTCFullYear();
  const covered = new Set(years.map((y) => y.startsOn.slice(0, 4)));
  let suggestedYear = currentYear;
  while (covered.has(String(suggestedYear))) suggestedYear += 1;
  const suggestedStart = `${suggestedYear}-${String(startMonth).padStart(2, "0")}-01`;

  return (
    <Shell
      principal={principal}
      title="Fiscal calendar"
      breadcrumbs={[{ label: "Accounting", href: "/accounting" }, { label: "Fiscal calendar" }]}
    >
      <div className="space-y-4">
        {startMonth === 1 && (
          <Alert tone="info">
            The fiscal year is configured to start in January. That is the default, not a confirmed
            answer — check it with CAC&rsquo;s accountant before the first year end, and change it
            under Settings if it is wrong.
          </Alert>
        )}

        {canManage && (
          <Panel
            title="Set up a fiscal year"
            description="Creates the year and all of its periods in one step. Period boundaries are computed, so there is no gap for an entry date to fall into."
          >
            <FiscalYearForm suggestedStart={suggestedStart} />
          </Panel>
        )}

        <Panel title="Fiscal years">
          {years.length === 0 ? (
            <EmptyState
              title="No fiscal year yet"
              body="Nothing can be posted until one exists."
            />
          ) : (
            <DataTable columns={["Year", "From", "To", "Periods", "Status", ""]} caption="Fiscal years">
              {years.map((year) => {
                const own = periods.filter((p) => p.fiscalYearId === year.id);
                const openCount = own.filter((p) => p.status !== "closed").length;
                return (
                  <tr key={year.id}>
                    <Td>
                      <span className="font-medium">{year.name}</span>
                    </Td>
                    <Td>{formatDate(year.startsOn)}</Td>
                    <Td>{formatDate(year.endsOn)}</Td>
                    <Td numeric>
                      {own.length}
                      {openCount > 0 && (
                        <span className="ml-1 text-[11px] text-[var(--color-muted)]">
                          ({openCount} not closed)
                        </span>
                      )}
                    </Td>
                    <Td>
                      <Badge tone={year.status === "open" ? "ok" : "neutral"}>{year.status}</Badge>
                    </Td>
                    <Td>
                      {year.status === "open" && canClose ? (
                        <CloseYearForm fiscalYearId={year.id} name={year.name} />
                      ) : (
                        <span className="text-[var(--color-faint)]">—</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </DataTable>
          )}
        </Panel>

        {periods.length > 0 && (
          <Panel
            title="Periods"
            description="Open accepts postings. Locked is a reversible freeze for review. Closed is final — reopening it is audited."
          >
            <DataTable
              columns={["Period", "Name", "From", "To", "Drafts", "Status", "Change"]}
              caption="Accounting periods"
            >
              {periods.map((period) => {
                const draftCount = draftsByPeriod.get(period.code) ?? 0;
                return (
                  <tr key={period.id}>
                    <Td>
                      <span className="font-mono text-[12px]">{period.code}</span>
                    </Td>
                    <Td>{period.name}</Td>
                    <Td>{formatDate(period.startsOn)}</Td>
                    <Td>{formatDate(period.endsOn)}</Td>
                    <Td numeric>
                      {draftCount === 0 ? (
                        <span className="text-[var(--color-faint)]">—</span>
                      ) : (
                        <span className="text-[var(--color-warn)]">{draftCount}</span>
                      )}
                    </Td>
                    <Td>
                      <Badge
                        tone={
                          period.status === "open"
                            ? "ok"
                            : period.status === "locked"
                              ? "warn"
                              : "neutral"
                        }
                      >
                        {period.status}
                      </Badge>
                    </Td>
                    <Td>
                      <PeriodActions
                        periodId={period.id}
                        status={period.status}
                        code={period.code}
                        canLock={canLock}
                        canClose={canClose}
                      />
                    </Td>
                  </tr>
                );
              })}
            </DataTable>
          </Panel>
        )}
      </div>
    </Shell>
  );
}
