import { getDb } from "@cac/db";
import {
  MATTER_TYPES,
  describeCondition,
  formatDate,
  listFactDefinitions,
  listRequirementRules,
} from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, Panel, Td } from "@/components/ui";
import { FactDefinitionForm, RuleApproval, RuleForm } from "../CaseForms";

/**
 * Intake questions and requirement rules.
 *
 * This screen is where a legal requirement enters the platform, and it is built to make
 * that entry deliberate and traceable:
 *
 *   * A question is declared before any rule can refer to it, because a rule waiting on
 *     a fact nobody records never resolves.
 *   * A rule names the authority it comes from. The field is required, at the database.
 *   * A rule is a draft until somebody *else*, holding `case.rule.approve`, approves it.
 *     Nothing on a draft reaches any checklist.
 *   * An approved version is immutable. A revision is a new version, so "what did this
 *     rule require when that checklist was built" always has an answer.
 *
 * Nothing is seeded. CAC supplies the rules and the authorities they rest on — the
 * platform does not write Malaysian probate law from general knowledge (Q-LEGAL-1,
 * Q-LEGAL-2).
 */
export default async function RulesPage() {
  const principal = await requireCapability("case.rule.view");
  const db = await getDb();

  const [facts, rules] = await Promise.all([
    listFactDefinitions(db),
    listRequirementRules(db),
  ]);

  const canPropose = principal.capabilities.has("case.rule.propose");
  const canApprove = principal.capabilities.has("case.rule.approve");

  const labels = new Map(facts.map((fact) => [fact.key, fact.label]));
  const drafts = rules.filter((rule) => rule.status === "draft");
  const approved = rules.filter((rule) => rule.status === "approved");
  const retired = rules.filter((rule) => rule.status === "retired");

  const matterTypeOptions = MATTER_TYPES.map((type) => ({ value: type.value, label: type.label }));

  return (
    <Shell
      principal={principal}
      title="Questions and rules"
      breadcrumbs={[{ label: "Cases", href: "/cases" }, { label: "Questions and rules" }]}
    >
      <div className="space-y-4">
        <Alert tone="info">
          A checklist is not a fixed list per case type. It is computed from the facts of a matter
          against the rules below — so two probate matters with different facts get different lists,
          and every item names the rule and the authority that put it there. A rule that depends on
          an unanswered question leaves its item on the checklist, flagged, rather than removing it.
        </Alert>

        {approved.length === 0 && (
          <Alert tone="warn">
            No rule has been approved, so no matter has a checklist. That is the state this platform
            ships in: Malaysian probate requirements are not written here from general knowledge.
            They are entered with their authority and approved by a named person qualified to do so
            (Q-LEGAL-1, Q-LEGAL-2).
          </Alert>
        )}

        {/* ---------------------------------------------------------------- */}
        <Panel
          title={`Intake questions (${facts.length})`}
          description="What a matter is asked. A rule can only read a question that exists here."
        >
          {facts.length === 0 ? (
            <EmptyState
              title="No questions declared"
              body="Declare one below. Until then no rule can have a condition, and every rule applies to every matter of its kind."
            />
          ) : (
            <DataTable
              columns={["Key", "Question", "Kind", "Answers offered", "Asked on", "Read by", "Active"]}
              caption="Intake questions"
            >
              {facts.map((fact) => (
                <tr key={fact.id} className={fact.isActive ? "" : "opacity-60"}>
                  <Td>
                    <span className="font-mono text-[12px]">{fact.key}</span>
                  </Td>
                  <Td>
                    {fact.label}
                    {fact.prompt && (
                      <span className="block text-[11px] text-[var(--color-muted)]">
                        {fact.prompt}
                      </span>
                    )}
                  </Td>
                  <Td>{fact.kind}</Td>
                  <Td>
                    {fact.options.length > 0 ? (
                      <span className="text-[11px]">{fact.options.join(", ")}</span>
                    ) : (
                      <span className="text-[var(--color-faint)]">—</span>
                    )}
                  </Td>
                  <Td>
                    <span className="text-[11px]">
                      {fact.matterTypes.length === 0
                        ? "every matter"
                        : fact.matterTypes
                            .map(
                              (type) =>
                                MATTER_TYPES.find((entry) => entry.value === type)?.label ?? type,
                            )
                            .join(", ")}
                    </span>
                  </Td>
                  <Td numeric>{fact.usedByRules}</Td>
                  <Td>
                    {fact.isActive ? <Badge tone="ok">asked</Badge> : <Badge tone="neutral">retired</Badge>}
                  </Td>
                </tr>
              ))}
            </DataTable>
          )}
          {canPropose && (
            <div className="mt-4 border-t border-[var(--color-line)] pt-4">
              <FactDefinitionForm matterTypes={matterTypeOptions} />
            </div>
          )}
        </Panel>

        {/* ---------------------------------------------------------------- */}
        {drafts.length > 0 && (
          <Panel
            title={`${drafts.length} rule${drafts.length === 1 ? "" : "s"} awaiting approval`}
            description="A draft appears on no checklist, and whoever wrote it cannot approve it."
          >
            <div className="space-y-4">
              {drafts.map((rule) => (
                <div
                  key={rule.id}
                  className="grid gap-3 border-b border-[var(--color-line)] pb-4 last:border-0 last:pb-0 sm:grid-cols-[1fr_220px]"
                >
                  <div>
                    <p className="text-[13px] font-medium">
                      {rule.title}
                      <span className="ml-2 font-mono text-[11px] text-[var(--color-muted)]">
                        {rule.code} v{rule.version}
                      </span>
                    </p>
                    {rule.detail && (
                      <p className="mt-1 text-[12px] text-[var(--color-muted)]">{rule.detail}</p>
                    )}
                    <p className="mt-1 text-[11px] text-[var(--color-muted)]">
                      {rule.kind} ·{" "}
                      {rule.matterTypes.length === 0
                        ? "every matter"
                        : rule.matterTypes.join(", ")}
                    </p>
                    <p className="mt-1 text-[12px]">
                      Applies when: {describeCondition(rule.appliesWhen, labels)}
                    </p>
                    <p className="mt-1 text-[11px] text-[var(--color-muted)]">
                      Authority: {rule.sourceRef}
                    </p>
                    <p className="text-[11px] text-[var(--color-muted)]">
                      Written by {rule.createdByName ?? "—"}
                    </p>
                  </div>
                  {canApprove && (
                    <RuleApproval
                      ruleId={rule.id}
                      label={`${rule.code} v${rule.version}`}
                      approved={false}
                    />
                  )}
                </div>
              ))}
            </div>
          </Panel>
        )}

        {/* ---------------------------------------------------------------- */}
        <Panel title={`In force (${approved.length})`}>
          {approved.length === 0 ? (
            <EmptyState title="No rule is in force" />
          ) : (
            <DataTable
              columns={["Rule", "What is required", "Applies when", "Authority", "Approved by", "On cases", ""]}
              caption="Rules in force"
            >
              {approved.map((rule) => (
                <tr key={rule.id}>
                  <Td>
                    <span className="font-mono text-[12px]">
                      {rule.code} v{rule.version}
                    </span>
                    <span className="block text-[11px] text-[var(--color-muted)]">{rule.kind}</span>
                  </Td>
                  <Td>
                    {rule.title}
                    {rule.matterTypes.length > 0 && (
                      <span className="block text-[11px] text-[var(--color-muted)]">
                        {rule.matterTypes.join(", ")}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <span className="text-[12px]">{describeCondition(rule.appliesWhen, labels)}</span>
                    {(rule.effectiveFrom || rule.effectiveTo) && (
                      <span className="block text-[11px] text-[var(--color-muted)]">
                        {rule.effectiveFrom ? `from ${formatDate(rule.effectiveFrom)}` : ""}
                        {rule.effectiveTo ? ` until ${formatDate(rule.effectiveTo)}` : ""}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <span className="text-[11px]">{rule.sourceRef}</span>
                  </Td>
                  <Td>
                    <span className="text-[11px]">{rule.approvedByName ?? "—"}</span>
                  </Td>
                  <Td numeric>{rule.usedOnCases}</Td>
                  <Td>
                    {canApprove && (
                      <RuleApproval
                        ruleId={rule.id}
                        label={`${rule.code} v${rule.version}`}
                        approved
                      />
                    )}
                  </Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Panel>

        {/* ---------------------------------------------------------------- */}
        {retired.length > 0 && (
          <Panel
            title={`Superseded and withdrawn (${retired.length})`}
            description="Kept, because a checklist item generated from one of these still names it."
          >
            <DataTable columns={["Rule", "What it required", "Authority", "On cases"]} caption="Retired rules">
              {retired.map((rule) => (
                <tr key={rule.id} className="opacity-70">
                  <Td>
                    <span className="font-mono text-[12px]">
                      {rule.code} v{rule.version}
                    </span>
                  </Td>
                  <Td>
                    {rule.title}
                    {rule.notes && (
                      <span className="block text-[11px] text-[var(--color-muted)]">{rule.notes}</span>
                    )}
                  </Td>
                  <Td>
                    <span className="text-[11px]">{rule.sourceRef}</span>
                  </Td>
                  <Td numeric>{rule.usedOnCases}</Td>
                </tr>
              ))}
            </DataTable>
          </Panel>
        )}

        {/* ---------------------------------------------------------------- */}
        {canPropose && (
          <Panel
            title="Write a rule, or a new version of one"
            description="Saved as a draft. Somebody else has to approve it before it can reach any checklist."
          >
            <RuleForm
              facts={facts
                .filter((fact) => fact.isActive)
                .map((fact) => ({ key: fact.key, label: fact.label, kind: fact.kind }))}
              matterTypes={matterTypeOptions}
            />
          </Panel>
        )}
      </div>
    </Shell>
  );
}
