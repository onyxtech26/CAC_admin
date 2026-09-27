import type { Principal } from "@cac/core";

/**
 * "Only this person's rows" — for a person who may not be an employee here.
 *
 * Three self-service screens wrote the same thing three times:
 *
 *     employeeId: onlyMine ? (principal.employeeId ?? "none") : undefined
 *
 * The intent is clear enough — `undefined` means every employee, so something else was needed for
 * "nobody" — but `"none"` is not a uuid, and Postgres rejects the parameter before it can fail to
 * match anything. The screen did not show an empty list: it returned a 500. Any account that holds
 * the capability without being linked to an employee record hit it, which includes every
 * administrator and every account created before its employee row existed. The payslips screen
 * even had the right message written and ready, three lines below the query that made sure nobody
 * would ever see it.
 *
 * So the filter is resolved here instead, into three honest states, and the caller has to say what
 * it does about the third one.
 */
export type OwnEmployeeFilter =
  /** Everybody: the caller may see other people's rows and has not narrowed it. */
  | { scope: "all"; employeeId: undefined }
  /** One person, who exists. */
  | { scope: "own"; employeeId: string }
  /** One person, who has no employee record — so the answer is "no rows", not a query. */
  | { scope: "unlinked"; employeeId: undefined };

export function ownEmployeeFilter(
  principal: Principal,
  restrictToOwn: boolean,
): OwnEmployeeFilter {
  if (!restrictToOwn) return { scope: "all", employeeId: undefined };
  if (principal.employeeId) return { scope: "own", employeeId: principal.employeeId };
  return { scope: "unlinked", employeeId: undefined };
}

/**
 * The sentence shown when an account is not linked to an employee record.
 *
 * One wording rather than three, because it is one situation and the person reading it is being
 * told the same thing each time: nothing is wrong with them, the link is missing, and somebody
 * else does it.
 */
export const UNLINKED_ACCOUNT =
  "Your account is not linked to an employee record, so there is nothing of your own to show here. " +
  "An administrator links the two on the employee's page.";
