import { NextResponse } from "next/server";
import { getDb } from "@cac/db";
import { AUDIT, formatAmount, receivablesAging, today, toIsoDate, writeAudit } from "@cac/core";
import { getPrincipal, getRequestContext } from "@/lib/auth";
import { toCsv } from "@/lib/csv";

/**
 * The aging report as CSV.
 *
 * CSV rather than .xlsx: it opens in Excel, in Numbers, in Sheets and in a text
 * editor, and it has no file-format surface to get wrong. If CAC needs cell
 * formatting and formulas rather than figures, that is a different feature and
 * should be asked for rather than assumed.
 *
 * Exporting is audited. This is a list of who owes the firm money, and where it
 * goes afterwards is outside the system.
 */
export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return new NextResponse("Sign in to continue.", { status: 401 });
  if (!principal.mfaSatisfied || !principal.capabilities.has("accounting.report.export")) {
    return new NextResponse("You do not have permission to export reports.", { status: 403 });
  }

  const asOf = new URL(request.url).searchParams.get("asOf") || toIsoDate(today());
  const db = await getDb();
  const aging = await receivablesAging(db, { asOf });

  const bucketLabels = aging.rows[0]?.buckets.map((bucket) => bucket.label) ?? [];
  const header = [
    "Customer code",
    "Customer",
    "Not due",
    ...bucketLabels,
    "Total",
    "On account",
    "Net owing",
    "Oldest due date",
  ];

  const rows = aging.rows.map((row) => [
    row.customerCode,
    row.customerName,
    formatAmount(row.current, { grouped: false }),
    ...row.buckets.map((bucket) => formatAmount(bucket.amount, { grouped: false })),
    formatAmount(row.total, { grouped: false }),
    formatAmount(row.unallocatedReceipts, { grouped: false }),
    formatAmount(row.netOwing, { grouped: false }),
    row.oldestDueDate ?? "",
  ]);

  rows.push([
    "",
    "TOTAL",
    formatAmount(aging.totals.current, { grouped: false }),
    ...aging.totals.buckets.map((amount) => formatAmount(amount, { grouped: false })),
    formatAmount(aging.totals.total, { grouped: false }),
    formatAmount(aging.totals.unallocatedReceipts, { grouped: false }),
    formatAmount(aging.totals.netOwing, { grouped: false }),
    "",
  ]);

  await writeAudit(db, {
    ...(await getRequestContext()),
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.EXPORT_SENSITIVE,
    entityType: "report",
    entityId: "receivables_aging",
    newValues: { asOf, customers: aging.rows.length, format: "csv" },
  });

  return new NextResponse(toCsv(header, rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="receivables-aging-${asOf}.csv"`,
      "cache-control": "private, no-store",
    },
  });
}
