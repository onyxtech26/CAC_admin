import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import {
  ASSET_CATEGORIES,
  LIABILITY_CATEGORIES,
  PARTY_ROLES,
  describePosition,
  estatePosition,
  formatAmount,
  formatDate,
  getCase,
  listAssets,
  listDocuments,
  listLiabilities,
  listParties,
  toIsoDate,
  today,
} from "@cac/core";
import { requireAnyCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, Panel, Td, TotalRow } from "@/components/ui";
import {
  AssetForm,
  DocumentForm,
  LiabilityForm,
  PartyForm,
  RemoveDocumentButton,
  VerifyControl,
} from "../../CaseForms";
import { CaseTabs } from "../CaseTabs";

/**
 * The file: who is involved, what the estate holds and owes, and which documents CAC
 * has.
 *
 * Two things are visible everywhere on this page and are the point of it.
 *
 * **Reported is not verified.** Every row says which it is, and who attested to it.
 * "The bank confirmed the balance" and "the son thought it was about that" are
 * different claims, and a file that cannot tell them apart is not much use.
 *
 * **A figure names its source.** The inventory shows how each figure was arrived at and
 * the document behind it, and the totals say plainly when they are incomplete rather
 * than presenting a part as a whole.
 */
export default async function CaseFilePage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireAnyCapability(["case.view", "case.view_all"]);
  const { id } = await params;
  const db = await getDb();

  const record = await getCase(db, principal, id);
  if (!record) notFound();

  const canSeeDocuments = principal.capabilities.has("case.document.view");

  const [parties, assets, liabilities, documents, position] = await Promise.all([
    listParties(db, principal, id),
    listAssets(db, principal, id),
    listLiabilities(db, principal, id),
    canSeeDocuments ? listDocuments(db, principal, id) : Promise.resolve([]),
    estatePosition(db, principal, id),
  ]);

  const canEdit = principal.capabilities.has("case.edit");
  const canVerify = principal.capabilities.has("case.fact.verify");
  const canRegister = principal.capabilities.has("case.document.upload");
  const canRemove = principal.capabilities.has("case.document.delete");
  const closed = record.status === "closed" || record.status === "withdrawn";
  const editable = canEdit && !closed;

  return (
    <Shell
      principal={principal}
      title={`${record.caseNo} — the file`}
      breadcrumbs={[
        { label: "Cases", href: "/cases" },
        { label: record.caseNo, href: `/cases/${id}` },
        { label: "The file" },
      ]}
    >
      <div className="space-y-4">
        <CaseTabs caseId={id} active="file" />

        {closed && (
          <Alert tone="neutral">
            This matter is {record.status}. The file is fixed until it is reopened.
          </Alert>
        )}

        <Alert tone={position.incomplete ? "warn" : "info"}>{describePosition(position)}</Alert>

        {/* ---------------------------------------------------------------- */}
        <Panel
          title={`The people in the matter (${parties.length})`}
          description="A stated entitlement always names where it came from. Who inherits what is a legal question; this records what CAC was told."
        >
          {parties.length === 0 ? (
            <EmptyState title="Nobody recorded yet" />
          ) : (
            <DataTable
              columns={["Role", "Name", "Relationship", "Contact", "Stated entitlement", "Status", ""]}
              caption="Parties"
            >
              {parties.map((party) => (
                <tr key={party.id} className={party.status === "excluded" ? "opacity-60" : ""}>
                  <Td>
                    {PARTY_ROLES.find((role) => role.value === party.role)?.label ?? party.role}
                    {party.isMinor && <Badge tone="warn">minor</Badge>}
                  </Td>
                  <Td>
                    {party.fullName}
                    {party.idLast4 && (
                      <span className="ml-1 font-mono text-[11px] text-[var(--color-muted)]">
                        ···{party.idLast4}
                      </span>
                    )}
                    {party.partyKind === "organisation" && (
                      <span className="block text-[11px] text-[var(--color-muted)]">organisation</span>
                    )}
                  </Td>
                  <Td>{party.relationship ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
                  <Td>
                    <span className="text-[11px]">
                      {[party.phone, party.email].filter(Boolean).join(" · ") || "—"}
                    </span>
                  </Td>
                  <Td>
                    {party.shareNote ? (
                      <>
                        {party.shareNote}
                        <span className="block text-[11px] text-[var(--color-muted)]">
                          per {party.shareSource}
                        </span>
                      </>
                    ) : (
                      <span className="text-[var(--color-faint)]">not stated</span>
                    )}
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        party.status === "verified"
                          ? "ok"
                          : party.status === "excluded"
                            ? "neutral"
                            : "info"
                      }
                    >
                      {party.status}
                    </Badge>
                    {party.verifiedByName && (
                      <span className="block text-[11px] text-[var(--color-muted)]">
                        by {party.verifiedByName}
                      </span>
                    )}
                    {party.exclusionReason && (
                      <span className="block text-[11px] text-[var(--color-muted)]">
                        {party.exclusionReason}
                      </span>
                    )}
                  </Td>
                  <Td>
                    {canEdit && !closed && (
                      <VerifyControl
                        caseId={id}
                        kind="party"
                        recordId={party.id}
                        status={party.status}
                        canVerify={canVerify}
                      />
                    )}
                  </Td>
                </tr>
              ))}
            </DataTable>
          )}
          {editable && (
            <div className="mt-4 border-t border-[var(--color-line)] pt-4">
              <PartyForm
                caseId={id}
                roles={PARTY_ROLES.map((role) => ({ value: role.value, label: role.label }))}
              />
            </div>
          )}
        </Panel>

        {/* ---------------------------------------------------------------- */}
        <Panel
          title={`What the estate holds (${assets.length})`}
          description="A figure, how it was arrived at, and the document behind it — all four together or none."
        >
          {assets.length === 0 ? (
            <EmptyState title="No assets recorded yet" />
          ) : (
            <DataTable
              columns={["Kind", "Description", "Held", "Figure", "How, and from what", "Status", ""]}
              caption="Estate assets"
            >
              {assets.map((asset) => (
                <tr key={asset.id} className={asset.status === "excluded" ? "opacity-60" : ""}>
                  <Td>
                    {ASSET_CATEGORIES.find((category) => category.value === asset.category)?.label ??
                      asset.category}
                  </Td>
                  <Td>
                    {asset.description}
                    {asset.referenceLast4 && (
                      <span className="block font-mono text-[11px] text-[var(--color-muted)]">
                        ···{asset.referenceLast4}
                      </span>
                    )}
                    {asset.location && (
                      <span className="block text-[11px] text-[var(--color-muted)]">
                        {asset.location}
                      </span>
                    )}
                  </Td>
                  <Td>
                    {asset.ownership}
                    {asset.ownershipNote && (
                      <span className="block text-[11px] text-[var(--color-muted)]">
                        {asset.ownershipNote}
                      </span>
                    )}
                  </Td>
                  <Td numeric>
                    {asset.valuationAmount === null ? (
                      <span className="text-[var(--color-warn)]">no figure</span>
                    ) : (
                      formatAmount(asset.valuationAmount)
                    )}
                  </Td>
                  <Td>
                    {asset.valuationBasis ? (
                      <>
                        {asset.valuationBasis}
                        <span className="block text-[11px] text-[var(--color-muted)]">
                          {asset.valuationSource} · as at {formatDate(asset.valuationDate!)}
                        </span>
                      </>
                    ) : (
                      <span className="text-[var(--color-faint)]">—</span>
                    )}
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        asset.status === "verified"
                          ? "ok"
                          : asset.status === "excluded"
                            ? "neutral"
                            : "info"
                      }
                    >
                      {asset.status}
                    </Badge>
                    {asset.verifiedByName && (
                      <span className="block text-[11px] text-[var(--color-muted)]">
                        by {asset.verifiedByName}
                      </span>
                    )}
                  </Td>
                  <Td>
                    {canEdit && !closed && (
                      <VerifyControl
                        caseId={id}
                        kind="asset"
                        recordId={asset.id}
                        status={asset.status}
                        canVerify={canVerify}
                      />
                    )}
                  </Td>
                </tr>
              ))}
              <TotalRow>
                <Td>Recorded</Td>
                <Td>
                  {position.assetsUnvalued > 0 && (
                    <span className="text-[11px] font-normal text-[var(--color-warn)]">
                      {position.assetsUnvalued} with no figure — this is not the estate's total
                    </span>
                  )}
                </Td>
                <Td>{null}</Td>
                <Td numeric>{formatAmount(position.assetTotal)}</Td>
                <Td>{null}</Td>
                <Td>{null}</Td>
                <Td>{null}</Td>
              </TotalRow>
            </DataTable>
          )}
          {editable && (
            <div className="mt-4 border-t border-[var(--color-line)] pt-4">
              <AssetForm
                caseId={id}
                categories={ASSET_CATEGORIES.map((category) => ({
                  value: category.value,
                  label: category.label,
                }))}
              />
            </div>
          )}
        </Panel>

        {/* ---------------------------------------------------------------- */}
        <Panel title={`What the estate owes (${liabilities.length})`}>
          {liabilities.length === 0 ? (
            <EmptyState title="No liabilities recorded yet" />
          ) : (
            <DataTable
              columns={["Kind", "Who is owed", "Description", "Figure", "How, and from what", "Status", ""]}
              caption="Estate liabilities"
            >
              {liabilities.map((liability) => (
                <tr key={liability.id} className={liability.status === "excluded" ? "opacity-60" : ""}>
                  <Td>
                    {LIABILITY_CATEGORIES.find((category) => category.value === liability.category)
                      ?.label ?? liability.category}
                    {liability.isSecured && <Badge tone="warn">secured</Badge>}
                  </Td>
                  <Td>{liability.creditor}</Td>
                  <Td>
                    {liability.description}
                    {liability.securityNote && (
                      <span className="block text-[11px] text-[var(--color-muted)]">
                        {liability.securityNote}
                      </span>
                    )}
                    {liability.referenceLast4 && (
                      <span className="block font-mono text-[11px] text-[var(--color-muted)]">
                        ···{liability.referenceLast4}
                      </span>
                    )}
                  </Td>
                  <Td numeric>
                    {liability.amount === null ? (
                      <span className="text-[var(--color-warn)]">no figure</span>
                    ) : (
                      formatAmount(liability.amount)
                    )}
                  </Td>
                  <Td>
                    {liability.amountBasis ? (
                      <>
                        {liability.amountBasis}
                        <span className="block text-[11px] text-[var(--color-muted)]">
                          {liability.amountSource} · as at {formatDate(liability.amountAsAt!)}
                        </span>
                      </>
                    ) : (
                      <span className="text-[var(--color-faint)]">—</span>
                    )}
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        liability.status === "verified"
                          ? "ok"
                          : liability.status === "excluded"
                            ? "neutral"
                            : "info"
                      }
                    >
                      {liability.status}
                    </Badge>
                  </Td>
                  <Td>
                    {canEdit && !closed && (
                      <VerifyControl
                        caseId={id}
                        kind="liability"
                        recordId={liability.id}
                        status={liability.status}
                        canVerify={canVerify}
                      />
                    )}
                  </Td>
                </tr>
              ))}
              <TotalRow>
                <Td>Recorded</Td>
                <Td>{null}</Td>
                <Td>
                  {position.liabilitiesUnvalued > 0 && (
                    <span className="text-[11px] font-normal text-[var(--color-warn)]">
                      {position.liabilitiesUnvalued} with no figure
                    </span>
                  )}
                </Td>
                <Td numeric>{formatAmount(position.liabilityTotal)}</Td>
                <Td>{null}</Td>
                <Td>{null}</Td>
                <Td>{null}</Td>
              </TotalRow>
            </DataTable>
          )}
          {editable && (
            <div className="mt-4 border-t border-[var(--color-line)] pt-4">
              <LiabilityForm
                caseId={id}
                categories={LIABILITY_CATEGORIES.map((category) => ({
                  value: category.value,
                  label: category.label,
                }))}
              />
            </div>
          )}
        </Panel>

        {/* ---------------------------------------------------------------- */}
        {canSeeDocuments && (
          <Panel
            title={`Documents held (${documents.length})`}
            description="A register: what CAC holds and where it is. The files themselves arrive in Phase 10, with scanning and extraction — this does not pretend to store them."
          >
            {documents.length === 0 ? (
              <EmptyState title="Nothing registered yet" />
            ) : (
              <DataTable
                columns={["What", "Form", "Received", "From", "Filed at", "Satisfies", ""]}
                caption="Document register"
              >
                {documents.map((document) => (
                  <tr key={document.id}>
                    <Td>
                      {document.title}
                      {document.docKind && (
                        <span className="block text-[11px] text-[var(--color-muted)]">
                          {document.docKind}
                        </span>
                      )}
                    </Td>
                    <Td>{document.form.replace("_", " ")}</Td>
                    <Td>
                      {document.receivedOn ? (
                        formatDate(document.receivedOn)
                      ) : (
                        <span className="text-[var(--color-faint)]">—</span>
                      )}
                    </Td>
                    <Td>{document.receivedFrom ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
                    <Td>{document.filedAt ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
                    <Td numeric>{document.satisfies}</Td>
                    <Td>
                      {canRemove && !closed && (
                        <RemoveDocumentButton caseId={id} documentId={document.id} />
                      )}
                    </Td>
                  </tr>
                ))}
              </DataTable>
            )}
            {canRegister && !closed && (
              <div className="mt-4 border-t border-[var(--color-line)] pt-4">
                <DocumentForm caseId={id} today={toIsoDate(today())} />
              </div>
            )}
          </Panel>
        )}
      </div>
    </Shell>
  );
}
