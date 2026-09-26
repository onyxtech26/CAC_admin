import "server-only";
import { getSettings } from "@cac/core";
import type { Executor } from "@cac/db";
import type { CompanyDetails } from "./document-pdf";

/**
 * The letterhead, read once and in one place.
 *
 * It was assembled inline in every route that renders a document, each with its own fallback — and
 * the fallback for the company's name was the firm's actual name typed into six files. That is not a
 * fabrication, the name is seeded and correct, but it is six places to change and six chances for a
 * document to go out with the wrong one.
 *
 * The fallbacks here are empty rather than invented. A missing address prints nothing, which is
 * visibly missing; a plausible address that nobody entered is worse, because it looks right.
 */
export async function companyDetails(db: Executor): Promise<CompanyDetails> {
  const settings = await getSettings(db, [
    "company.name",
    "company.address",
    "company.email",
    "company.phone",
    "company.registration_no",
    "tax.sst_registration_no",
  ]);

  return {
    name: String(settings["company.name"] ?? ""),
    address: String(settings["company.address"] ?? ""),
    email: String(settings["company.email"] ?? ""),
    phone: String(settings["company.phone"] ?? ""),
    registrationNo: (settings["company.registration_no"] as string) ?? null,
    sstNumber: (settings["tax.sst_registration_no"] as string) ?? null,
  };
}
