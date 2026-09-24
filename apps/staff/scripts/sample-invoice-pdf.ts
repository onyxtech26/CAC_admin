/**
 * Renders one invoice to a PDF file, outside the web server.
 *
 * For checking the document by eye during development, and for attaching a real
 * example to a discussion without asking somebody to sign in and click through.
 * It reads the same invoice and calls the same renderer the application does, so
 * what comes out is what a customer would receive.
 *
 *   pnpm --filter @cac/staff sample-pdf                 # the most recent issued invoice
 *   pnpm --filter @cac/staff sample-pdf INV-2026-00001  # a specific one
 *   OUT=/tmp/x.pdf pnpm --filter @cac/staff sample-pdf  # somewhere else
 *
 * The application must be stopped first: the local database is embedded and only
 * one process may own it.
 *
 * Wrapped in a main() rather than using top-level await because this package is
 * CommonJS, and tsx compiles a .ts file here accordingly.
 */
import { writeFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "@cac/db";
import { getInvoice, getSettings } from "@cac/core";
import { renderInvoicePdf } from "../src/lib/invoice-pdf.js";

async function main(): Promise<void> {
  const wanted = process.argv[2];
  const db = await getDb();

  const found = await db.execute<{ id: string; invoice_no: string }>(
    wanted
      ? sql`SELECT id, invoice_no FROM accounting.invoice WHERE invoice_no = ${wanted}`
      : sql`SELECT id, invoice_no FROM accounting.invoice
             WHERE status IN ('issued', 'paid', 'void')
             ORDER BY issued_at DESC LIMIT 1`,
  );

  const row = found.rows?.[0];
  if (!row) {
    console.error(wanted ? `No invoice numbered ${wanted}.` : "No issued invoice to render.");
    await closeDb();
    process.exit(1);
  }

  const invoice = await getInvoice(db, row.id);
  const settings = await getSettings(db, [
    "company.name",
    "company.address",
    "company.email",
    "company.phone",
    "company.registration_no",
    "tax.sst_registration_no",
  ]);

  const pdf = await renderInvoicePdf(invoice!, {
    name: String(settings["company.name"] ?? "Conglomerate Appraisal Consultancy"),
    address: String(settings["company.address"] ?? ""),
    email: String(settings["company.email"] ?? ""),
    phone: String(settings["company.phone"] ?? ""),
    registrationNo: (settings["company.registration_no"] as string) ?? null,
    sstNumber: (settings["tax.sst_registration_no"] as string) ?? null,
  });

  const out = process.env.OUT ?? `${row.invoice_no}.pdf`;
  await writeFile(out, pdf);
  console.log(`Wrote ${out} (${pdf.length} bytes) for ${row.invoice_no}.`);

  await closeDb();
  process.exit(0);
}

main().catch((error) => {
  console.error("Could not render the invoice:", error);
  process.exit(1);
});
