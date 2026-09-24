import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import { formatAmount, formatDate, getJournal, getSetting, today, toIsoDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import {
  Alert,
  Badge,
  DataTable,
  LinkButton,
  Panel,
  Td,
  TotalRow,
} from "@/components/ui";
import { DeleteDraft, PostJournal, ReverseJournal } from "./JournalActions";

const STATUS_TONE = { draft: "warn", posted: "ok", reversed: "neutral" } as const;

/**
 * One journal.
 *
 * The header answers the questions an auditor asks in order: what is it, when, in
 * which period, who prepared it, who posted it, and if it was reversed, by what
 * and why.
 */
export default async function JournalPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("accounting.journal.view");
  const { id } = await params;
  const db = await getDb();

  const journal = await getJournal(db, id);
  if (!journal) notFound();

  const secondPersonRequired = await getSetting(
    db,
    "accounting.journal_requires_second_person",
    true,
  );

  const canPost = principal.capabilities.has("accounting.journal.post");
  const canReverse = principal.capabilities.has("accounting.journal.reverse");
  const canEdit =
    journal.status === "draft" &&
    principal.capabilities.has("accounting.journal.create") &&
    (journal.createdBy === principal.userId || canPost);

  const reversalDate =
    journal.periodStatus === "open" ? journal.entryDate : toIsoDate(today());

  return (
    <Shell
      principal={principal}
      title={journal.journalNo ?? "Draft journal"}
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Journals", href: "/accounting/journals" },
        { label: journal.journalNo ?? "Draft" },
      ]}
      actions={
        canEdit ? (
          <LinkButton href={`/accounting/journals/${journal.id}/edit`}>Edit draft</LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {journal.status === "reversed" && (
          <Alert tone="warn">
            This journal was reversed by{" "}
            <Link
              href={`/accounting/journals/${journal.reversedById}`}
              className="font-mono underline"
            >
              {journal.reversedByNo}
            </Link>
            . Both entries remain in the ledger and cancel each other out.
          </Alert>
        )}
        {journal.reversesId && (
          <Alert tone="info">
            This is the reversal of{" "}
            <Link href={`/accounting/journals/${journal.reversesId}`} className="font-mono underline">
              {journal.reversesNo}
            </Link>
            . Reason given: {journal.reversalReason}
          </Alert>
        )}
        {journal.status === "draft" && (
          <Alert tone="info">
            This is a draft. It has no number, affects no balances and appears in no report until it is
            posted.
          </Alert>
        )}

        <Panel title="Details">
          <dl className="grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
            <Detail label="Status">
              <Badge tone={STATUS_TONE[journal.status]}>{journal.status}</Badge>
            </Detail>
            <Detail label="Entry date">{formatDate(journal.entryDate)}</Detail>
            <Detail label="Period">
              <span className="font-mono text-[12px]">{journal.periodCode}</span>{" "}
              <span className="text-[11px] text-[var(--color-muted)]">({journal.periodStatus})</span>
            </Detail>
            <Detail label="Source">{journal.sourceType}</Detail>
            <Detail label="Prepared by">{journal.createdByName}</Detail>
            <Detail label="Prepared at">{formatDate(String(journal.createdAt))}</Detail>
            <Detail label="Posted by">
              {journal.postedByName ?? <span className="text-[var(--color-faint)]">—</span>}
            </Detail>
            <Detail label="Posted at">
              {journal.postedAt ? (
                new Date(journal.postedAt).toLocaleString("en-GB")
              ) : (
                <span className="text-[var(--color-faint)]">—</span>
              )}
            </Detail>
            {journal.memo && (
              <div className="sm:col-span-2 lg:col-span-4">
                <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-faint)]">
                  Memo
                </dt>
                <dd className="mt-0.5">{journal.memo}</dd>
              </div>
            )}
          </dl>
        </Panel>

        <Panel title="Lines">
          <DataTable
            columns={["#", "Account", "Narrative", "Cost centre", "Debit", "Credit"]}
            caption="Journal lines"
          >
            {journal.lines.map((line) => (
              <tr key={line.id}>
                <Td>{line.lineNo}</Td>
                <Td>
                  <Link
                    href={`/accounting/accounts/${line.accountCode}`}
                    className="text-[var(--color-info)] hover:underline"
                  >
                    <span className="font-mono text-[12px]">{line.accountCode}</span> {line.accountName}
                  </Link>
                </Td>
                <Td>{line.description ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
                <Td>
                  {line.costCentreCode ?? <span className="text-[var(--color-faint)]">—</span>}
                </Td>
                <Td numeric>{formatAmount(line.debit, { zeroAs: "—" })}</Td>
                <Td numeric>{formatAmount(line.credit, { zeroAs: "—" })}</Td>
              </tr>
            ))}
            <TotalRow>
              <Td>{""}</Td>
              <Td>Totals</Td>
              <Td>{""}</Td>
              <Td>{""}</Td>
              <Td numeric>{formatAmount(journal.totalDebit)}</Td>
              <Td numeric>{formatAmount(journal.totalCredit)}</Td>
            </TotalRow>
          </DataTable>

          {journal.totalDebit !== journal.totalCredit && (
            <div className="mt-3">
              <Alert tone="danger">
                Debits and credits do not agree. This journal cannot be posted until they do.
              </Alert>
            </div>
          )}
        </Panel>

        {(journal.status === "draft" || (journal.status === "posted" && canReverse)) && (
          <Panel title="Actions">
            <div className="space-y-4">
              {journal.status === "draft" && canPost && (
                <PostJournal
                  journalId={journal.id}
                  selfPrepared={journal.createdBy === principal.userId}
                  secondPersonRequired={secondPersonRequired}
                />
              )}
              {journal.status === "draft" && !canPost && (
                <p className="text-[12px] text-[var(--color-muted)]">
                  You do not hold the capability to post journals. Someone with it has to review this
                  entry.
                </p>
              )}
              {journal.status === "draft" && canEdit && <DeleteDraft journalId={journal.id} />}
              {journal.status === "posted" && canReverse && (
                <ReverseJournal
                  journalId={journal.id}
                  journalNo={journal.journalNo!}
                  defaultDate={reversalDate}
                />
              )}
            </div>
          </Panel>
        )}
      </div>
    </Shell>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-faint)]">
        {label}
      </dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
