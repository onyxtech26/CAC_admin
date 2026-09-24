import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import { formatDate, getLetter } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, LinkButton, Panel, Td, DataTable } from "@/components/ui";
import { LetterActions } from "../LetterForms";

const TONE = {
  draft: "neutral",
  approved: "info",
  issued: "ok",
  cancelled: "neutral",
} as const;

export default async function LetterPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("hr.letter.generate");
  const { id } = await params;
  const db = await getDb();

  const letter = await getLetter(db, id);
  if (!letter) notFound();

  return (
    <Shell
      principal={principal}
      title={letter.letterNo ?? "Draft letter"}
      breadcrumbs={[
        { label: "Human resources" },
        { label: "Letters", href: "/hr/letters" },
        { label: letter.letterNo ?? "Draft" },
      ]}
      actions={
        <div className="flex gap-2">
          <LinkButton href={`/hr/letters/${id}/pdf`}>PDF</LinkButton>
          <LinkButton href={`/hr/letters/${id}/docx`} variant="primary">
            Word
          </LinkButton>
        </div>
      }
    >
      <div className="space-y-4">
        {letter.status !== "issued" && (
          <Alert tone="warn">
            Not issued. Both the PDF and the Word file carry a DRAFT line, so a copy in circulation
            cannot be mistaken for the real thing.
          </Alert>
        )}

        {letter.supersededByNo && (
          <Alert tone="info">
            Superseded by {letter.supersededByNo}. This letter is unchanged — it is what the person
            was given, and it stays that way.
          </Alert>
        )}

        {letter.cancelReason && <Alert tone="danger">Cancelled: {letter.cancelReason}</Alert>}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Panel title={letter.subject}>
              {/* The stored rendered text, exactly as the PDF and the Word file print it.
                  Nothing re-renders the template here. */}
              <div className="whitespace-pre-wrap text-[13px] leading-relaxed">
                {letter.bodyRendered}
              </div>
            </Panel>

            <Panel
              title="What this letter was filled in with"
              description="Kept with the letter, so it can be re-rendered identically and so a figure on it can be traced."
            >
              <DataTable columns={["Field", "Value"]} caption="Values used">
                {letter.variables.map((variable) => (
                  <tr key={variable.key}>
                    <Td>
                      {variable.label}
                      <span className="ml-1 font-mono text-[10px] text-[var(--color-faint)]">
                        {variable.key}
                      </span>
                    </Td>
                    <Td>
                      {String(letter.valuesUsed[variable.key] ?? "") || (
                        <span className="text-[var(--color-faint)]">not set</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </DataTable>
            </Panel>
          </div>

          <div className="space-y-4">
            <Panel title="Details">
              <dl className="space-y-2 text-[13px]">
                <Row label="Status">
                  <Badge tone={TONE[letter.status]}>{letter.status}</Badge>
                </Row>
                <Row label="To">
                  <Link
                    href={`/hr/employees/${letter.employeeId}`}
                    className="text-[var(--color-info)] hover:underline"
                  >
                    {letter.employeeName}
                  </Link>
                </Row>
                <Row label="Dated">{formatDate(letter.letterDate)}</Row>
                <Row label="Template">
                  <span className="font-mono text-[12px]">
                    {letter.templateCode} v{letter.templateVersion}
                  </span>
                </Row>
                <Row label="Approved by">{letter.approvedByName ?? "—"}</Row>
                <Row label="Issued by">{letter.issuedByName ?? "—"}</Row>
                {letter.deliveryNote && <Row label="Delivered">{letter.deliveryNote}</Row>}
                {letter.supersedesLetterNo && (
                  <Row label="Supersedes">{letter.supersedesLetterNo}</Row>
                )}
              </dl>
              {letter.notes && (
                <p className="mt-2 border-t border-[var(--color-line)] pt-2 text-[12px] text-[var(--color-muted)]">
                  {letter.notes}
                </p>
              )}
            </Panel>

            <Panel title="What happens next">
              <LetterActions
                letterId={id}
                status={letter.status}
                canApprove={principal.capabilities.has("hr.letter.approve")}
                canIssue={principal.capabilities.has("hr.letter.generate")}
                // Whoever generated it cannot approve it.
                isAuthor={letter.createdBy === principal.userId}
              />
            </Panel>

            {letter.status === "issued" && !letter.supersededByNo && (
              <Panel title="If it was wrong">
                <p className="text-[12px] text-[var(--color-muted)]">
                  Generate a corrected letter that supersedes this one. Both stay on the record,
                  which is what somebody holding a copy of the first deserves.
                </p>
                <p className="mt-2 text-[12px]">
                  <Link href="/hr/letters" className="text-[var(--color-info)] hover:underline">
                    Write the correction
                  </Link>
                </p>
              </Panel>
            )}
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
