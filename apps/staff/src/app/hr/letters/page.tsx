import Link from "next/link";
import { getDb } from "@cac/db";
import {
  formatDate,
  letterDefaults,
  listEmployees,
  listLetters,
  listTemplates,
  today,
  toIsoDate,
} from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import {
  Alert,
  Badge,
  DataTable,
  EmptyState,
  LinkButton,
  Panel,
  StatTile,
  Td,
} from "@/components/ui";
import { GenerateLetterForm } from "./LetterForms";

const TONE = {
  draft: "neutral",
  approved: "info",
  issued: "ok",
  cancelled: "neutral",
} as const;

/**
 * Employment letters.
 *
 * The list is the record of what the firm has told its staff. A letter that has been
 * superseded still shows what it said — the correction is a separate letter, and both
 * are visible, because somebody is holding a copy of the first one.
 */
export default async function LettersPage() {
  const principal = await requireCapability("hr.letter.generate");
  const db = await getDb();

  const [letters, templates, employees] = await Promise.all([
    listLetters(db, { limit: 300 }),
    listTemplates(db),
    listEmployees(db, { limit: 1000 }),
  ]);

  const approvedTemplates = templates.filter((row) => row.status === "approved");
  const waiting = letters.filter((row) => row.status === "draft" || row.status === "approved");

  // Pre-fill values per employee. Done here because the form is a client component and
  // the employee record is not its business to fetch.
  const defaultsByEmployee: Record<string, Record<string, string>> = {};
  for (const employee of employees.slice(0, 200)) {
    defaultsByEmployee[employee.id] = await letterDefaults(db, employee.id);
  }

  return (
    <Shell
      principal={principal}
      title="Letters"
      breadcrumbs={[{ label: "Human resources" }, { label: "Letters" }]}
      actions={<LinkButton href="/hr/letters/templates">Templates</LinkButton>}
    >
      <div className="space-y-4">
        {approvedTemplates.length === 0 && (
          <Alert tone="warn">
            No approved template exists, so no letter can be generated. A template has to be written
            and then approved by somebody else — the wording of an appointment letter is a commitment
            by the firm, not a form of words one person chooses.
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile
            label="Awaiting a step"
            value={String(waiting.length)}
            hint={waiting.length > 0 ? "drafts and approved letters not yet issued" : "nothing outstanding"}
            tone={waiting.length > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label="Issued"
            value={String(letters.filter((row) => row.status === "issued").length)}
            hint="documents people hold"
          />
          <StatTile
            label="Templates in use"
            value={String(approvedTemplates.length)}
            hint={`${templates.length} versions in total`}
          />
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="space-y-4 xl:col-span-2">
            <Panel title={`${letters.length} letter${letters.length === 1 ? "" : "s"}`}>
              {letters.length === 0 ? (
                <EmptyState
                  title="No letters yet"
                  body="Generate one from an approved template. It keeps its own copy of the wording, so revising the template later cannot change what somebody was told."
                />
              ) : (
                <DataTable
                  columns={["Reference", "Date", "To", "About", "Template", "Status", ""]}
                  caption="Employment letters"
                >
                  {letters.map((letter) => (
                    <tr key={letter.id}>
                      <Td>
                        <Link
                          href={`/hr/letters/${letter.id}`}
                          className="font-mono text-[12px] text-[var(--color-info)] hover:underline"
                        >
                          {letter.letterNo ?? "draft"}
                        </Link>
                      </Td>
                      <Td>{formatDate(letter.letterDate)}</Td>
                      <Td>
                        <Link
                          href={`/hr/employees/${letter.employeeId}`}
                          className="text-[var(--color-info)] hover:underline"
                        >
                          {letter.employeeName}
                        </Link>
                      </Td>
                      <Td>{letter.subject}</Td>
                      <Td>
                        <span className="font-mono text-[11px]">
                          {letter.templateCode} v{letter.templateVersion}
                        </span>
                      </Td>
                      <Td>
                        <Badge tone={TONE[letter.status]}>{letter.status}</Badge>
                      </Td>
                      <Td>
                        {letter.supersededByNo ? (
                          <span className="text-[10px] text-[var(--color-muted)]">
                            superseded by {letter.supersededByNo}
                          </span>
                        ) : letter.supersedesLetterNo ? (
                          <span className="text-[10px] text-[var(--color-muted)]">
                            supersedes {letter.supersedesLetterNo}
                          </span>
                        ) : (
                          ""
                        )}
                      </Td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Panel>
          </div>

          <div className="space-y-4">
            <Panel title="Write a letter">
              <GenerateLetterForm
                templates={approvedTemplates.map((row) => ({
                  code: row.code,
                  name: row.name,
                  kind: row.kind,
                  version: row.version,
                  variables: row.variables.map((variable) => ({
                    key: variable.key,
                    label: variable.label,
                    type: variable.type,
                    required: variable.required !== false,
                    hint: variable.hint,
                  })),
                }))}
                employees={employees.map((row) => ({
                  id: row.id,
                  employeeNo: row.employeeNo,
                  fullName: row.fullName,
                }))}
                defaultsByEmployee={defaultsByEmployee}
                defaultDate={toIsoDate(today())}
              />
            </Panel>

            <Panel title="Why a letter keeps its own copy">
              <p className="text-[12px] text-[var(--color-muted)]">
                The wording, the values and the rendered text are all stored on the letter. Revising
                the template next year cannot change what somebody was told this year, and a letter
                produced in a dispute reads exactly as it did when it was handed over. The template
                version it came from is printed on the document.
              </p>
            </Panel>
          </div>
        </div>
      </div>
    </Shell>
  );
}
