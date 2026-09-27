import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import {
  assistantFromEnv,
  buildCasePack,
  findContradictions,
  findGaps,
  getCase,
  nextQuestions,
  relevantPassages,
  similarMatters,
} from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, LinkButton, Panel, StatTile, Td } from "@/components/ui";
import { CaseTabs } from "../CaseTabs";

const SEVERITY_TONE = {
  blocking: "danger",
  incomplete: "warn",
  worth_checking: "info",
} as const;

/** Where each gap is dealt with, so the link goes somewhere useful. */
const WHERE = {
  intake: { path: "/intake", label: "intake" },
  file: { path: "/file", label: "the file" },
  checklist: { path: "/checklist", label: "checklist" },
  matter: { path: "", label: "the matter" },
} as const;

const SEVERITY_LABEL = {
  blocking: "blocking",
  incomplete: "incomplete",
  worth_checking: "worth checking",
} as const;

/**
 * The case agent.
 *
 * Everything on this page is computed from what has been recorded: which question to ask
 * next and what answering it would unblock, what is missing, what contradicts itself, which
 * past matters answered the same questions the same way, and which library passages the
 * matter's own words turn up. None of it needs a model, and that is the honest shape of
 * "an agent that helps with a probate matter" — the useful parts are questions of
 * completeness and consistency, and those have exact answers.
 *
 * The drafting half is absent and says so. The governing rule from the plan holds either
 * way: the rule engine decides requirements, the model would only assist, cite and draft,
 * and nothing here submits anything to anybody.
 */
export default async function CaseAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("case.agent.run");
  const { id } = await params;
  const db = await getDb();

  const record = await getCase(db, principal, id);
  if (!record) notFound();

  const assistant = assistantFromEnv();

  const [questions, gaps, contradictions, similar, passages, pack] = await Promise.all([
    nextQuestions(db, principal, id),
    findGaps(db, principal, id),
    findContradictions(db, principal, id),
    similarMatters(db, principal, id),
    principal.capabilities.has("doc.view")
      ? relevantPassages(db, principal, id)
      : Promise.resolve({ passages: [], query: "", note: "" }),
    buildCasePack(db, principal, id),
  ]);

  const blocking = gaps.filter((gap) => gap.severity === "blocking");
  const unblocking = questions.filter((question) => question.blocks.length > 0);

  return (
    <Shell
      principal={principal}
      title={`${record.caseNo} — agent`}
      breadcrumbs={[
        { label: "Cases", href: "/cases" },
        { label: record.caseNo, href: `/cases/${id}` },
        { label: "Agent" },
      ]}
      actions={
        <LinkButton href={`/cases/${id}/pack`} variant="primary">
          Preparation pack (PDF)
        </LinkButton>
      }
    >
      <div className="space-y-4">
        <CaseTabs caseId={id} active="agent" />

        <Alert tone="info">
          Everything below is computed from what has been recorded on this matter. Nothing here
          states what Malaysian law requires: every requirement comes from a rule entered with
          its authority and approved by a named reviewer, and the items under{" "}
          <em>what to check</em> are disagreements between recorded fields, phrased as questions
          because the platform does not know which side is right.
        </Alert>

        {!assistant.isConfigured() && (
          <Alert tone="warn">
            No drafting model is configured, and nothing here will draft legal text without one.
            Configuring one is Q-AI-1 (which provider, hosted where — these files hold
            identifiable people&apos;s data) and Q-LEGAL-2 (which authorities it may cite), and a
            named legal reviewer must hold <span className="font-mono">case.document.approve</span>{" "}
            under Q-LEGAL-1 before anything drafted could be approved. The work on this page needs
            none of that.
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Questions to ask"
            value={String(questions.length)}
            hint={unblocking.length > 0 ? `${unblocking.length} unblock a requirement` : undefined}
            tone="warn"
          />
          <StatTile
            label="Blocking gaps"
            value={String(blocking.length)}
            hint={blocking.length > 0 ? "An approved rule is waiting" : undefined}
            tone="danger"
          />
          <StatTile label="Things to check" value={String(contradictions.length)} />
          <StatTile label="Similar matters" value={String(similar.length)} />
        </div>

        {/* ---------------------------------------------------------------- */}
        <Panel
          title="What to ask next"
          description="Ordered by how many undecided requirements each answer would settle."
        >
          {questions.length === 0 ? (
            <EmptyState
              title="Every declared question has an answer"
              body="Either the intake is complete, or no questions have been declared for this kind of matter."
            />
          ) : (
            <ol className="space-y-3">
              {questions.map((question) => (
                <li
                  key={question.factKey}
                  className="border-b border-[var(--color-line)] pb-3 last:border-0 last:pb-0"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-[13px] font-medium">{question.prompt ?? question.label}</p>
                    {question.blocks.length > 0 ? (
                      <Badge tone="warn">
                        unblocks {question.blocks.length} requirement
                        {question.blocks.length === 1 ? "" : "s"}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">no rule waiting</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">
                    <span className="font-mono">{question.factKey}</span> · {question.kind}
                    {question.recordedUnknown && " · already recorded as not known"}
                  </p>
                  {question.blocks.length > 0 && (
                    <p className="mt-1 text-[12px] text-[var(--color-muted)]">
                      Waiting on it: {question.blocks.map((entry) => entry.title).join("; ")}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
          <p className="mt-3 text-[12px]">
            <Link href={`/cases/${id}/intake`} className="text-[var(--color-link)] hover:underline">
              Answer them on the intake screen
            </Link>
          </p>
        </Panel>

        {/* ---------------------------------------------------------------- */}
        <Panel
          title={`What is missing (${gaps.length})`}
          description="Gaps in what has been written down. “Blocking” means an approved rule is actually waiting on it."
        >
          {gaps.length === 0 ? (
            <EmptyState title="Nothing the platform can see" />
          ) : (
            <DataTable columns={["", "What", "What it holds up", "Where"]} caption="Gaps">
              {gaps.map((gap, index) => (
                <tr key={index}>
                  <Td>
                    <Badge tone={SEVERITY_TONE[gap.severity]}>{SEVERITY_LABEL[gap.severity]}</Badge>
                  </Td>
                  <Td>{gap.what}</Td>
                  <Td>
                    {gap.blocks ?? <span className="text-[var(--color-faint)]">—</span>}
                  </Td>
                  <Td>
                    <Link
                      href={`/cases/${id}${WHERE[gap.where].path}`}
                      className="text-[11px] text-[var(--color-link)] hover:underline"
                    >
                      {WHERE[gap.where].label}
                    </Link>
                  </Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Panel>

        {/* ---------------------------------------------------------------- */}
        <Panel
          title={`What to check (${contradictions.length})`}
          description="Two recorded fields that disagree. The platform does not know which is right, so each one is a question."
        >
          {contradictions.length === 0 ? (
            <EmptyState title="Nothing recorded contradicts anything else recorded" />
          ) : (
            <ul className="space-y-3">
              {contradictions.map((contradiction, index) => (
                <li
                  key={index}
                  className="rounded-md border border-[var(--color-line)] p-3"
                >
                  <p className="text-[13px]">{contradiction.what}</p>
                  <p className="mt-1 text-[12px] text-[var(--color-muted)]">{contradiction.check}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* ---------------------------------------------------------------- */}
        <Panel
          title={`Similar matters (${similar.length})`}
          description="Past matters that answered the same questions the same way. CAC's own experience — not precedent, which is case law."
        >
          {similar.length === 0 ? (
            <EmptyState
              title="Nothing comparable yet"
              body="Similarity is measured on shared answers to the intake questions, so it needs answers on both matters."
            />
          ) : (
            <DataTable
              columns={["Matter", "Overlap", "What they share", "How it ended"]}
              caption="Similar matters"
            >
              {similar.map((entry) => (
                <tr key={entry.caseId}>
                  <Td>
                    <Link
                      href={`/cases/${entry.caseId}`}
                      className="font-mono text-[12px] text-[var(--color-link)] hover:underline"
                    >
                      {entry.caseNo}
                    </Link>
                    <span className="block text-[11px] text-[var(--color-muted)]">{entry.title}</span>
                  </Td>
                  <Td numeric>{Math.round(entry.similarity * 100)}%</Td>
                  <Td>
                    <span className="text-[11px]">
                      {entry.sharedAnswers
                        .map((answer) => `${answer.label}: ${answer.value}`)
                        .join(" · ")}
                    </span>
                  </Td>
                  <Td>
                    <span className="text-[11px]">
                      {entry.status}
                      {entry.outcome ? ` — ${entry.outcome}` : ""}
                    </span>
                  </Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Panel>

        {/* ---------------------------------------------------------------- */}
        {principal.capabilities.has("doc.view") && (
          <Panel
            title={`Passages worth reading (${passages.passages.length})`}
            description="From the document library, searched on this matter's own words and filtered to what you may see."
          >
            {passages.passages.length === 0 ? (
              <EmptyState
                title="Nothing in the library matches this matter yet"
                body="Documents have to be scanned and read before their contents can be searched."
              />
            ) : (
              <ol className="space-y-3">
                {passages.passages.map((passage) => (
                  <li key={passage.chunkId} className="rounded-md border border-[var(--color-line)] p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <Link
                        href={`/documents/${passage.documentId}`}
                        className="text-[13px] font-medium text-[var(--color-link)] hover:underline"
                      >
                        {passage.documentTitle}
                      </Link>
                      <span className="font-mono text-[11px] text-[var(--color-muted)]">
                        {passage.documentNo}
                        {passage.caseNo ? ` · ${passage.caseNo}` : ""}
                      </span>
                    </div>
                    <p className="mt-1 text-[13px] leading-relaxed">{passage.excerpt}</p>
                    <p className="mt-1 text-[11px] text-[var(--color-muted)]">
                      text read by {passage.method}
                      {passage.confidence !== null &&
                        ` at ${Math.round(passage.confidence * 100)}% confidence`}
                    </p>
                  </li>
                ))}
              </ol>
            )}
            {passages.note && (
              <p className="mt-3 text-[11px] text-[var(--color-muted)]">{passages.note}</p>
            )}
          </Panel>
        )}

        {/* ---------------------------------------------------------------- */}
        <Panel
          title="The preparation pack"
          description="Everything above, plus the matter, the people and the inventory, as one reviewable document."
        >
          <p className="text-[12px] text-[var(--color-muted)]">
            {pack.requirements.length} requirement(s), {pack.parties.length} people,{" "}
            {pack.assets.length} asset(s), {pack.liabilities.length} liability(ies),{" "}
            {pack.gaps.length} gap(s) and {pack.contradictions.length} thing(s) to check. The gaps
            are printed in the body of the pack rather than an appendix: a pack that showed only
            the complete parts would read as a finished matter.
          </p>
          <div className="mt-3">
            <LinkButton href={`/cases/${id}/pack`} variant="primary">
              Produce the pack
            </LinkButton>
          </div>
        </Panel>
      </div>
    </Shell>
  );
}
