import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import {
  formatAmount,
  formatDate,
  getSupplierInvoice,
  listSettlements,
  parseAmount,
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
  TotalRow,
} from "@/components/ui";
import { BillActions, RemoveSettlement, SettleForm } from "./BillActions";

const STATUS_TONE = {
  draft: "neutral",
  pending_approval: "warn",
  approved: "info",
  posted: "ok",
  settled: "ok",
  void: "danger",
} as const;

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  pending_approval: "Awaiting approval",
  approved: "Approved",
  posted: "Posted",
  settled: "Settled",
  void: "Void",
};

/**
 * One bill.
 *
 * Both reference numbers are at the top, CAC's and the supplier's, because the conversation about
 * a bill is always conducted in the supplier's.
 */
export default async function BillPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("accounting.bill.view");
  const { id } = await params;
  const db = await getDb();

  const bill = await getSupplierInvoice(db, id);
  if (!bill) notFound();

  const settlements = await listSettlements(db, id);

  // Posted payments to this supplier that still have something left to apply, and posted credit
  // notes from them that have not been used up. Both are candidates for settling this bill; the
  // database refuses anything from a different supplier, so this only has to be a helpful list
  // rather than a trustworthy one.
  const [vouchers, creditNotes] = await Promise.all([
    db.execute<{ id: string; voucher_no: string; total: string; applied: string; date: string }>(sql`
      SELECT v.id, v.voucher_no, v.total::text AS total, v.voucher_date::text AS date,
             COALESCE((SELECT SUM(amount) FROM accounting.payable_settlement WHERE voucher_id = v.id), 0)::text AS applied
        FROM accounting.payment_voucher v
       WHERE v.supplier_id = ${bill.supplierId}
         AND v.status = 'posted'
         AND v.total > COALESCE((SELECT SUM(amount) FROM accounting.payable_settlement WHERE voucher_id = v.id), 0)
       ORDER BY v.voucher_date DESC
       LIMIT 50
    `),
    db.execute<{ id: string; bill_no: string; total: string; applied: string }>(sql`
      SELECT cn.id, cn.bill_no, cn.total::text AS total,
             COALESCE((SELECT SUM(amount) FROM accounting.payable_settlement WHERE credit_note_id = cn.id), 0)::text AS applied
        FROM accounting.supplier_invoice cn
       WHERE cn.supplier_id = ${bill.supplierId}
         AND cn.kind = 'credit_note'
         AND cn.status IN ('posted', 'settled')
         AND cn.id <> ${id}
         AND cn.total > COALESCE((SELECT SUM(amount) FROM accounting.payable_settlement WHERE credit_note_id = cn.id), 0)
       ORDER BY cn.bill_date DESC
       LIMIT 50
    `),
  ]);

  const isCredit = bill.kind === "credit_note";
  const settleable = bill.status === "posted" && !isCredit && bill.outstanding > 0n;

  return (
    <Shell
      principal={principal}
      title={bill.billNo ?? `Draft bill — ${bill.supplierDocNo}`}
      breadcrumbs={[
        { label: "Purchases & payables" },
        { label: "Bills", href: "/accounting/bills" },
        { label: bill.billNo ?? "Draft" },
      ]}
      actions={
        bill.status === "draft" && principal.capabilities.has("accounting.bill.create") ? (
          <LinkButton href={`/accounting/bills/${id}/edit`}>Edit</LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {isCredit && (
          <Alert tone="info">
            This is a credit note from {bill.supplierName}. It reduces what CAC owes them, and is
            applied to a bill from the bill&rsquo;s own page.
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Total" value={formatAmount(bill.total)} hint={bill.supplierName} />
          <StatTile
            label="Outstanding"
            value={formatAmount(bill.outstanding)}
            hint={bill.outstanding === 0n ? "nothing left" : "still to settle"}
            tone={bill.outstanding > 0n ? "warn" : "neutral"}
          />
          <StatTile label="Due" value={formatDate(bill.dueDate)} hint={`dated ${formatDate(bill.billDate)}`} />
          <StatTile
            label="Their reference"
            value={bill.supplierDocNo}
            hint={`received ${formatDate(bill.receivedDate)}`}
          />
        </div>

        <Panel title="Status">
          <div className="space-y-3">
            <p className="flex flex-wrap items-center gap-2 text-[13px]">
              <Badge tone={STATUS_TONE[bill.status]}>{STATUS_LABEL[bill.status]}</Badge>
              {bill.journalNo && (
                <span className="text-[12px] text-[var(--color-muted)]">
                  posted as journal{" "}
                  <Link
                    href={`/accounting/journals`}
                    className="text-[var(--color-link)] hover:underline"
                  >
                    {bill.journalNo}
                  </Link>
                </span>
              )}
            </p>

            <BillActions
              billId={id}
              status={bill.status}
              canApprove={principal.capabilities.has("accounting.bill.approve")}
              canPost={principal.capabilities.has("accounting.bill.post")}
              canVoid={principal.capabilities.has("accounting.bill.void")}
              canEdit={principal.capabilities.has("accounting.bill.create")}
            />
          </div>
        </Panel>

        <Panel title={bill.subject ?? "Lines"}>
          <DataTable
            columns={["#", "Description", "Account", "Qty", "Unit price", "Tax", "Total"]}
            caption="Bill lines"
          >
            {bill.lines.map((line) => (
              <tr key={line.id}>
                <Td>{line.lineNo}</Td>
                <Td>{line.description}</Td>
                <Td>
                  <span className="font-mono text-[11px]">{line.accountCode}</span> {line.accountName}
                </Td>
                <Td numeric>{String(line.quantity)}</Td>
                <Td numeric>{formatAmount(line.unitPrice)}</Td>
                <Td numeric>{line.taxAmount === 0n ? "—" : formatAmount(line.taxAmount)}</Td>
                <Td numeric>{formatAmount(line.lineTotal)}</Td>
              </tr>
            ))}
            <TotalRow>
              <Td>&nbsp;</Td>
              <Td>Total</Td>
              <Td>&nbsp;</Td>
              <Td>&nbsp;</Td>
              <Td>&nbsp;</Td>
              <Td numeric>{formatAmount(bill.taxTotal)}</Td>
              <Td numeric>{formatAmount(bill.total)}</Td>
            </TotalRow>
          </DataTable>
          {bill.notes && (
            <p className="mt-3 text-[12px] text-[var(--color-muted)]">{bill.notes}</p>
          )}
        </Panel>

        {settleable && principal.capabilities.has("accounting.bill.settle") && (
          <Panel
            title="Settle"
            description="Apply a posted payment, or a credit note from the same supplier."
          >
            <SettleForm
              billId={id}
              outstanding={formatAmount(bill.outstanding)}
              vouchers={(vouchers.rows ?? []).map((row) => ({
                id: row.id,
                label: `${row.voucher_no} — ${formatAmount(
                  parseAmount(row.total) - parseAmount(row.applied),
                )} left, ${formatDate(row.date)}`,
              }))}
              creditNotes={(creditNotes.rows ?? []).map((row) => ({
                id: row.id,
                label: `${row.bill_no} — ${formatAmount(
                  parseAmount(row.total) - parseAmount(row.applied),
                )} left`,
              }))}
            />
          </Panel>
        )}

        <Panel title="What has been applied">
          {settlements.length === 0 ? (
            <EmptyState
              title="Nothing yet"
              body={
                bill.status === "posted"
                  ? "This bill is outstanding in full."
                  : "Payments and credit notes appear here once the bill is posted."
              }
            />
          ) : (
            <DataTable columns={["Source", "Reference", "Amount", "When", ""]} caption="Settlements">
              {settlements.map((settlement) => (
                <tr key={settlement.id}>
                  <Td>{settlement.sourceType === "voucher" ? "Payment" : "Credit note"}</Td>
                  <Td>{settlement.reference ?? "—"}</Td>
                  <Td numeric>{formatAmount(settlement.amount)}</Td>
                  <Td>{formatDate(settlement.settledAt.slice(0, 10))}</Td>
                  <Td>
                    {principal.capabilities.has("accounting.bill.settle") && (
                      <RemoveSettlement billId={id} settlementId={settlement.id} />
                    )}
                  </Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Panel>
      </div>
    </Shell>
  );
}
