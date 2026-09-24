import { getDb } from "@cac/db";
import {
  STATUTORY_LABELS,
  formatDate,
  listRuleVersions,
  rulesAvailableFor,
  today,
  toIsoDate,
} from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, Panel, Td } from "@/components/ui";
import { ApproveRule, RuleForm } from "./StatutoryForms";

/**
 * The statutory rules.
 *
 * This screen is where Q-HR-1 gets answered, and its whole job is to make the shape
 * of that answer obvious: a table per contribution, effective-dated, carrying the
 * document it was copied from, approved by somebody other than whoever typed it, and
 * fixed from then on.
 *
 * Nothing is pre-filled with a plausible rate. The rates are the law, CAC supplies
 * them, and a default here would be the platform quietly asserting something it does
 * not know.
 */
export default async function StatutoryPage() {
  const principal = await requireCapability("hr.statutory.view");
  const db = await getDb();

  const now = toIsoDate(today());
  const [versions, available] = await Promise.all([
    listRuleVersions(db),
    rulesAvailableFor(db, now),
  ]);

  const canManage = principal.capabilities.has("hr.statutory.manage");
  const drafts = versions.filter((row) => row.status === "draft");
  const missing = available.filter((row) => row.rule === null);

  return (
    <Shell
      principal={principal}
      title="Statutory rules"
      breadcrumbs={[
        { label: "Human resources" },
        { label: "Payroll", href: "/hr/payroll" },
        { label: "Statutory rules" },
      ]}
    >
      <div className="space-y-4">
        <Alert tone="info">
          <strong>None of these is a percentage in the code.</strong> EPF rates differ by age and
          wage band; SOCSO and EIS are contribution tables where the amount is read from the band
          rather than calculated; PCB is a schedule with reliefs. Writing any of them into the
          software would be the platform asserting Malaysian law it has not been told. They are
          entered here as data, with the document they came from, and approved by a second person.
        </Alert>

        {missing.length > 0 && (
          <Alert tone="warn">
            No rule is in force today for{" "}
            <strong>{missing.map((row) => row.label).join(", ")}</strong>. Payroll refuses to run
            until each is supplied and approved — which is the point, not a defect.
          </Alert>
        )}

        <Panel title="In force today">
          <DataTable columns={["Contribution", "From", "Until", "Source", "Approved by"]} caption="Rules in force">
            {available.map((row) => (
              <tr key={row.kind}>
                <Td>{row.label}</Td>
                <Td>
                  {row.rule ? (
                    formatDate(row.rule.effectiveFrom)
                  ) : (
                    <Badge tone="warn">not supplied</Badge>
                  )}
                </Td>
                <Td>
                  {row.rule?.effectiveTo ? (
                    formatDate(row.rule.effectiveTo)
                  ) : row.rule ? (
                    <span className="text-[var(--color-muted)]">current</span>
                  ) : (
                    "—"
                  )}
                </Td>
                <Td>
                  <span className="text-[11px] text-[var(--color-muted)]">
                    {row.rule?.sourceRef ?? "—"}
                  </span>
                </Td>
                <Td>
                  <span className="text-[11px] text-[var(--color-muted)]">
                    {versions.find((version) => version.id === row.rule?.id)?.approvedByName ?? "—"}
                  </span>
                </Td>
              </tr>
            ))}
          </DataTable>
        </Panel>

        {drafts.length > 0 && (
          <Panel
            title={`${drafts.length} awaiting approval`}
            description="A draft has no effect. Whoever entered it cannot approve it."
          >
            <DataTable
              columns={["Contribution", "From", "Source", "Entered by", "Bands", ""]}
              caption="Draft rules"
            >
              {drafts.map((version) => (
                <tr key={version.id}>
                  <Td>{STATUTORY_LABELS[version.kind]}</Td>
                  <Td>{formatDate(version.effectiveFrom)}</Td>
                  <Td>
                    <span className="text-[11px] text-[var(--color-muted)]">
                      {version.sourceRef}
                    </span>
                  </Td>
                  <Td>
                    <span className="text-[11px] text-[var(--color-muted)]">
                      {version.createdByName ?? "—"}
                    </span>
                  </Td>
                  <Td numeric>
                    {"bands" in version.table && Array.isArray(version.table.bands)
                      ? version.table.bands.length
                      : "—"}
                  </Td>
                  <Td>
                    {canManage && (
                      <ApproveRule
                        ruleId={version.id}
                        label={STATUTORY_LABELS[version.kind].split(" ")[0]!}
                      />
                    )}
                  </Td>
                </tr>
              ))}
            </DataTable>
          </Panel>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Panel title={`Every version (${versions.length})`}>
              {versions.length === 0 ? (
                <EmptyState
                  title="No statutory rules have been entered"
                  body="Until they are, payroll cannot compute a single figure — which is the honest state of affairs rather than a limitation to work around."
                />
              ) : (
                <DataTable
                  columns={["Contribution", "From", "Until", "Status", "Source", "Bands"]}
                  caption="Statutory rule versions"
                >
                  {versions.map((version) => (
                    <tr key={version.id}>
                      <Td>{STATUTORY_LABELS[version.kind]}</Td>
                      <Td>{formatDate(version.effectiveFrom)}</Td>
                      <Td>
                        {version.effectiveTo ? (
                          formatDate(version.effectiveTo)
                        ) : (
                          <span className="text-[var(--color-muted)]">current</span>
                        )}
                      </Td>
                      <Td>
                        <Badge
                          tone={
                            version.status === "approved"
                              ? "ok"
                              : version.status === "draft"
                                ? "warn"
                                : "neutral"
                          }
                        >
                          {version.status}
                        </Badge>
                      </Td>
                      <Td>
                        <span className="text-[11px] text-[var(--color-muted)]">
                          {version.sourceRef}
                        </span>
                        {version.sourceUrl && (
                          <a
                            href={version.sourceUrl}
                            className="ml-1 text-[11px] text-[var(--color-info)] hover:underline"
                            rel="noreferrer noopener"
                            target="_blank"
                          >
                            link
                          </a>
                        )}
                      </Td>
                      <Td numeric>
                        {"bands" in version.table && Array.isArray(version.table.bands)
                          ? version.table.bands.length
                          : "—"}
                      </Td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Panel>
          </div>

          <div className="space-y-4">
            {canManage ? (
              <Panel title="Enter a rule">
                <RuleForm defaultEffectiveFrom={`${now.slice(0, 4)}-01-01`} />
              </Panel>
            ) : (
              <Panel title="Entering rules">
                <p className="text-[12px] text-[var(--color-muted)]">
                  Entering and approving statutory rules is reserved to the people who hold
                  responsibility for them. A wrong table here is wrong for everybody, for twelve
                  months, before anybody notices.
                </p>
              </Panel>
            )}

            <Panel title="Why a version rather than a setting">
              <p className="text-[12px] text-[var(--color-muted)]">
                Rates change. If this were a setting, changing it in April would silently change what
                March&rsquo;s payroll computes, and a past payslip could never be reproduced. Instead
                each version has dates, is immutable once approved, and every payslip line records
                which version produced it. Recomputing March reads March&rsquo;s version and gets
                March&rsquo;s answer.
              </p>
            </Panel>
          </div>
        </div>
      </div>
    </Shell>
  );
}
