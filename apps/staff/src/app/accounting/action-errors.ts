import "server-only";
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@cac/core";

/**
 * Turning an exception into something worth reading.
 *
 * Shared by every accounting action so the rule is applied once: errors we raised
 * on purpose carry a message written for the person at the keyboard and are shown
 * verbatim. Anything else is a fault — the detail goes to the server log and the
 * browser gets an apology.
 *
 * That line matters. Database guard messages name constraints, tables and
 * sometimes values; echoing them back is an information leak, and it also tells
 * the user something they cannot act on. When one appears in the log it means the
 * application let through something the schema caught, which is a bug worth
 * seeing.
 */

export interface FormState {
  error?: string;
  field?: string;
  notice?: string;
}

export function toFormState(error: unknown, fallback: string): FormState {
  if (error instanceof ValidationError) return { error: error.message, field: error.field };
  if (error instanceof ConflictError || error instanceof NotFoundError) {
    return { error: error.message };
  }
  if (error instanceof AuthorizationError || error instanceof AuthenticationError) {
    return { error: error.message };
  }

  console.error("[accounting] unexpected error:", error);
  return { error: fallback };
}
