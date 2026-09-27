import Link from "next/link";
import { getDb } from "@cac/db";
import { resolveProvider, submissionReadiness } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, Panel, StatTile, Td } from "@/components/ui";

/**
 * Where e-Invoicing stands.
 *
 * This page exists precisely because the integration does not. It says what is
 * missing, who has to supply it, and what CAC can usefully do in the meantime —
 * which is real work: a TIN per customer takes weeks to collect and cannot be
 * started on the deadline.
 *
 * What it does not do is offer a button that appears to submit something.
 */
export default async function EInvoicePage() {
  const principal = await requireCapability("accounting.einvoice.view");
  const db = await getDb();

  const [status, readiness] = await Promise.all([
    resolveProvider(db),
    submissionReadiness(db, principal),
  ]);

  return (
    <Shell
      principal={principal}
      title="e-Invoice (MyInvois)"
      breadcrumbs={[{ label: "Accounting", href: "/accounting" }, { label: "e-Invoice" }]}
    >
      <div className="space-y-4">
        <Alert tone="warn">
          <strong>Not connected, and nothing has been submitted to LHDN.</strong> The adapter is
          written against LHDN&rsquo;s published API but has never been exercised, because no
          sandbox account exists yet. There is deliberately no mock that reports success: an
          invoice that looks validated when it was never sent is worse than one that plainly was
          not.
        </Alert>

        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile
            label="Provider"
            value={status.provider.name}
            hint={status.provider.environment ?? "no environment set"}
            tone="warn"
          />
          <StatTile
            label="In scope"
            value={status.inScope ? "yes" : "not recorded"}
            hint={
              status.inScope
                ? "recorded under Settings"
                : "an administrator confirms this once LHDN's timetable is known"
            }
            tone={status.inScope ? "neutral" : "warn"}
          />
          <StatTile
            label="Invoices issued so far"
            value={String(readiness.invoices)}
            hint="each would need submitting once CAC is in scope"
          />
        </div>

        <Panel title="What is still needed">
          <ol className="space-y-3 text-[13px]">
            {status.blockers.map((blocker, index) => (
              <li key={index} className="flex gap-3">
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--color-warn)] text-[11px] font-bold text-[var(--color-ink)]">
                  {index + 1}
                </span>
                <span>{blocker}</span>
              </li>
            ))}
          </ol>
          <p className="mt-3 border-t border-[var(--color-line)] pt-3 text-[12px] text-[var(--color-muted)]">
            These are the contents of Q-FIN-2: the TIN, the in-scope date, whether submission is
            direct or through an intermediary, and sandbox credentials. The API credentials are read
            from the server environment rather than stored here — a client secret in a settings
            table is a client secret in every database backup.
          </p>
        </Panel>

        <Panel
          title="Work that can be done now"
          description="None of this needs credentials, and all of it takes longer than the integration itself."
        >
          <div className="space-y-4">
            <div>
              <p className="text-[13px] font-medium">
                The company&rsquo;s own TIN{" "}
                {readiness.companyTinRecorded ? (
                  <Badge tone="ok">recorded</Badge>
                ) : (
                  <Badge tone="warn">missing</Badge>
                )}
              </p>
              <p className="mt-1 text-[12px] text-[var(--color-muted)]">
                Enter it under{" "}
                <Link href="/admin/settings" className="text-[var(--color-link)] hover:underline">
                  Settings
                </Link>{" "}
                as <span className="font-mono text-[11px]">tax.tin</span>. It is also what goes on
                invoices.
              </p>
            </div>

            <div>
              <p className="text-[13px] font-medium">
                A TIN for every customer that has been invoiced
                {readiness.customersWithoutTin.length === 0 ? (
                  <span className="ml-1">
                    <Badge tone="ok">complete</Badge>
                  </span>
                ) : (
                  <span className="ml-1">
                    <Badge tone="warn">{readiness.customersWithoutTin.length} missing</Badge>
                  </span>
                )}
              </p>
              {readiness.customersWithoutTin.length > 0 && (
                <>
                  <p className="mb-2 mt-1 text-[12px] text-[var(--color-muted)]">
                    MyInvois requires the buyer&rsquo;s TIN. Every invoice to a customer without one
                    would be rejected, so these have to be collected before submission becomes
                    mandatory — not after.
                  </p>
                  <DataTable
                    columns={["Customer", "Invoices issued"]}
                    caption="Customers with no tax identification number"
                  >
                    {readiness.customersWithoutTin.map((customer) => (
                      <tr key={customer.id}>
                        <Td>
                          <Link
                            href="/accounting/customers"
                            className="text-[var(--color-link)] hover:underline"
                          >
                            <span className="font-mono text-[11px]">{customer.code}</span>{" "}
                            {customer.name}
                          </Link>
                        </Td>
                        <Td numeric>{customer.invoices}</Td>
                      </tr>
                    ))}
                  </DataTable>
                </>
              )}
            </div>

            <div>
              <p className="text-[13px] font-medium">
                A classification code for each service CAC sells{" "}
                {readiness.accountsWithoutClassification.length === 0 ? (
                  <Badge tone="ok">complete</Badge>
                ) : (
                  <Badge tone="warn">
                    {readiness.accountsWithoutClassification.length} missing
                  </Badge>
                )}
              </p>
              <p className="mb-2 mt-1 text-[12px] text-[var(--color-muted)]">
                LHDN requires a code per invoice line from its own taxonomy. Mapping CAC&rsquo;s six
                services onto it is a judgement about what the firm does, not something to guess: a
                wrong code is a rejected submission whose cause is buried in LHDN&rsquo;s response.
                A submission refuses while any line lacks one.
                {" "}The code is recorded against the revenue account, so it is answered once per
                service rather than typed on every invoice.
              </p>
              {readiness.accountsWithoutClassification.length > 0 && (
                <DataTable
                  columns={["Account", ""]}
                  caption="Revenue accounts with no classification code"
                >
                  {readiness.accountsWithoutClassification.map((account) => (
                    <tr key={account.id}>
                      <Td>
                        <Link
                          href="/accounting/accounts"
                          className="text-[var(--color-link)] hover:underline"
                        >
                          <span className="font-mono text-[11px]">{account.code}</span>{" "}
                          {account.name}
                        </Link>
                      </Td>
                      <Td>{""}</Td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </div>
          </div>
        </Panel>

        <Panel title="What will happen once it is connected">
          <ul className="space-y-2 text-[12px] text-[var(--color-muted)]">
            <li>
              Issuing an invoice will submit it, and the invoice will carry LHDN&rsquo;s identifier
              once validated. Until validation, the invoice says so rather than claiming to be
              compliant.
            </li>
            <li>
              A rejection comes back as LHDN&rsquo;s own words against the invoice, because a
              paraphrase of a validation error is a paraphrase of the law.
            </li>
            <li>
              Cancelling a submitted document is a separate capability (
              <span className="font-mono text-[11px]">accounting.einvoice.cancel</span>) and needs a
              reason, which LHDN requires and the audit trail keeps.
            </li>
          </ul>
        </Panel>
      </div>
    </Shell>
  );
}
