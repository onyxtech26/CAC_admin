/**
 * Errors that are safe to show a user.
 *
 * Server actions catch these and render `message` verbatim, so every message
 * here is written for the person at the keyboard: what is wrong and what to do
 * about it, never a stack frame or a constraint name. Anything *not* one of
 * these is unexpected, and the UI shows a generic apology while the real detail
 * goes to the server log — an internal error message is an information leak.
 */

export class ValidationError extends Error {
  readonly code = "INVALID";
  constructor(
    message: string,
    /** Form field this belongs to, where there is one. */
    readonly field?: string,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

/** The request is well formed but the records are not in a state that allows it. */
export class ConflictError extends Error {
  readonly code = "CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class NotFoundError extends Error {
  readonly code = "NOT_FOUND";
  constructor(message = "That record no longer exists.") {
    super(message);
    this.name = "NotFoundError";
  }
}

export function isUserFacingError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof ValidationError ||
    error instanceof ConflictError ||
    error instanceof NotFoundError
  );
}
