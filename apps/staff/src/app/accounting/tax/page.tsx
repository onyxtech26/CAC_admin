import { getDb } from "@cac/db";
import { formatDate, formatRate, getSetting, listTaxCodes, listTaxRates } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, Panel, Td } from "@/components/ui";
import { TaxRateForm } from "./TaxRateForm";

/**
 * Tax configuration.
 *
 * The page exists mostly to be honest about a gap. No rate is seeded anywhere in
 * this system: whether CAC is SST registered, from when, and which of its
 * services are taxable is a question for CAC and its tax agent, and a
 * plausible-looking 6% entered on their behalf would appear on real invoices and
 * be collected from real customers.
 *
 * So the screen says what is switched off, what that means for invoices today,
 * and what somebody has to do about it.
 */
export default async function TaxPage() {
  const principal = await requireCapability("accounting.tax.view");
  const db = await getDb();

  const [codes, rates, registered, registrationNo] = await Promise.all([
    listTaxCodes(db),
    listTaxRates(db),
    getSetting<boolean>(db, "tax.sst_registered", false),
    getSetting<string | null>(db, "tax.sst_registration_no", null),
  ]);

  const canManage = principal.capabilities.has("accounting.tax.manage");

  return (
    <Shell
      principal={principal}
      title="Tax"
      breadcrumbs={[{ label: "Accounting", href: "/accounting" }, { label: "Tax" }]}
    >
      <div className="space-y-4">
        {!registered ? (
          <Alert tone="warn">
            <strong>No tax is being charged on any invoice.</strong> The company is not recorded as
            SST registered, so every invoice raised today shows a nil tax line. If CAC is registered,
            an administrator sets <span className="font-mono text-[11px]">tax.sst_registered</span>{" "}
            and the registration number under Settings, and a rate is recorded below — with its
            source. Nothing here is assumed on CAC&rsquo;s behalf. See Q-FIN-1 in
            docs/OPEN_QUESTIONS.md.
          </Alert>
        ) : rates.length === 0 ? (
          <Alert tone="warn">
            The company is marked SST registered but no rate has been entered, so invoices still show
            no tax. Record the rate below.
          </Alert>
        ) : (
          <Alert tone="ok">
            SST registered{registrationNo ? ` under ${registrationNo}` : ""}. Invoices carry tax at
            the rate in force on their own date.
          </Alert>
        )}

        <Panel
          title="Tax codes"
          description="A code says where tax of a given kind belongs. It becomes usable once a rate has been recorded for it."
        >
          <DataTable columns={["Code", "Name", "Kind", "Rate today", "Rates on file", "Status"]} caption="Tax codes">
            {codes.map((code) => (
              <tr key={code.id}>
                <Td>
                  <span className="font-mono text-[12px]">{code.code}</span>
                </Td>
                <Td>{code.name}</Td>
                <Td>
                  <span className="text-[11px] uppercase tracking-wide text-[var(--color-muted)]">
                    {code.kind}
                  </span>
                </Td>
                <Td numeric>{formatRate(code.currentRate)}</Td>
                <Td numeric>{code.rateCount === 0 ? "—" : code.rateCount}</Td>
                <Td>
                  {code.isActive ? (
                    <Badge tone="ok">In use</Badge>
                  ) : (
                    <Badge tone="warn">No rate yet</Badge>
                  )}
                </Td>
              </tr>
            ))}
          </DataTable>
        </Panel>

        <Panel
          title="Rates"
          description="Effective-dated. An invoice keeps the rate that applied on its own date, for ever, so historical documents reprint identically after a change."
        >
          {rates.length === 0 ? (
            <EmptyState
              title="No rate has been entered"
              body="Deliberately. A rate nobody has confirmed would appear on real invoices and be collected from real customers."
            />
          ) : (
            <DataTable columns={["Code", "Rate", "From", "Until", "Source"]} caption="Tax rates">
              {rates.map((rate) => (
                <tr key={rate.id}>
                  <Td>
                    <span className="font-mono text-[12px]">{rate.code}</span>
                  </Td>
                  <Td numeric>{formatRate(rate.rate)}</Td>
                  <Td>{formatDate(rate.effectiveFrom)}</Td>
                  <Td>
                    {rate.effectiveTo ? (
                      formatDate(rate.effectiveTo)
                    ) : (
                      <span className="text-[var(--color-muted)]">until further notice</span>
                    )}
                  </Td>
                  <Td>
                    <span className="text-[12px] text-[var(--color-muted)]">{rate.sourceRef}</span>
                  </Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Panel>

        {canManage && (
          <Panel
            title="Record a rate"
            description="Whoever enters this is asserting a statutory figure. It is recorded against their name."
          >
            <TaxRateForm taxCodes={codes.map((code) => ({ id: code.id, code: code.code, name: code.name }))} />
          </Panel>
        )}
      </div>
    </Shell>
  );
}
