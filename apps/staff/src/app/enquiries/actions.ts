"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@cac/db";
import { handleEnquiry, type EnquiryStatus } from "@cac/core";
import { getRequestContext, requireCapability } from "@/lib/auth";
import { toFormState, type FormState } from "../accounting/action-errors";

const STATUSES: EnquiryStatus[] = [
  "new",
  "in_progress",
  "answered",
  "converted",
  "spam",
  "closed",
];

/**
 * Records what the firm did about an enquiry.
 *
 * The status is matched against a closed set before it reaches the core — an unknown value is a bug
 * or an attack, and either way it stops here rather than becoming a CHECK-constraint error somebody
 * has to read the database to understand.
 */
export async function handleEnquiryAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const enquiryId = String(form.get("enquiryId") ?? "");
  const submitted = String(form.get("status") ?? "");
  const status = STATUSES.find((value) => value === submitted);

  if (!status) return { error: "That is not a status an enquiry can have." };

  try {
    const principal = await requireCapability("crm.enquiry.manage");
    const db = await getDb();
    const context = await getRequestContext();

    await db.transaction(async (tx) =>
      handleEnquiry(
        tx,
        principal,
        enquiryId,
        { status, note: String(form.get("note") ?? "").trim() || null },
        context,
      ),
    );
  } catch (error) {
    return toFormState(error, "That could not be recorded.");
  }

  revalidatePath("/enquiries");
  return { notice: "Recorded." };
}
