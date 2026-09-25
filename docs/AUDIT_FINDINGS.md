# CAC — End-to-end audit findings

A full end-to-end check of the platform: the staff application driven in a real browser, and six
parallel code audits covering accounting, HR and payroll, estate cases, documents, the
cross-cutting security model, and the public site.

Every finding below has been **verified against the source**, not taken on report. Deliberate,
documented refusals (payroll without statutory tables, an empty checklist without approved rules,
an unconfigured scanner leaving a file in quarantine) are **not** listed as defects — they are
correct behaviour recorded in `docs/OPEN_QUESTIONS.md`.

Status: **audit complete for the slices marked ✅ below; findings not yet fixed.**

| Slice | Auditor | Status |
|---|---|---|
| Browser end-to-end (auth, every screen) | driven directly | ✅ |
| Accounting (Phases 2, 3a, 3b, 4) | agent | ✅ |
| Cross-cutting: auth, RBAC, audit, nav | agent | ✅ |
| HR and payroll (Phases 5–7) | agent | in progress |
| Estate cases and the agent (9, 11) | agent | in progress |
| Documents (8, 10, 12) | agent | in progress |
| Public site (`apps/web`) | agent | in progress |

---

## 1. Verified in the browser — what works

Driven end to end in a real browser against a running dev server, on a freshly bootstrapped
database. **This is the first time any screen has been exercised by use rather than by test.**

- **The whole authentication chain.** Password sign-in → forced password change on an
  administrator-generated password → authenticator enrolment (secret shown, code verified, ten
  single-use recovery codes issued once) → sign-out → password + TOTP sign-in → dashboard. The MFA
  challenge correctly refuses an expired code and says so.
- **Password change revokes other sessions** and says so on screen.
- **`must_change_password` is enforced** on every capability-gated route: navigating to
  `/admin/users` with a handover password redirects to `/account?change-password=1`.
- **You cannot grant yourself a role.** The role screen renders every button as *"You cannot grant
  yourself a role."* — a separation-of-duties control that no test covered.
- **RBAC is visibly live.** A user with DIRECTOR + ACCOUNTANT + CASE_MANAGER + HR_MANAGER +
  LAWYER_OR_AUTHORISED_REVIEWER (124 capabilities) reaches `/admin/settings` and `/admin/audit` but
  is redirected to `/denied?capability=admin.user.manage` for the user screen.
- **All 52 screens render with the correct heading and no error.** 21 accounting, 14 HR, 3 case, 1
  document library, 2 admin, plus the dashboard, account, login, MFA and denied pages.
- **`/api/health`** returns `{"ok":true}` with the operator detail, correctly gated.
- **The single-writer database lock works and explains itself.** Running a CLI script while the dev
  server holds the data directory produced a precise message naming the owning process and what to
  do about it.
- **The dashboard tells the truth about its own gaps**: "14 settings to confirm — blocking some
  modules", each named.

---

## 2. Blocking defects

### 2.1 A credit note can be edited past the amount it is allowed to credit

`packages/core/src/sales.ts:429` — `updateInvoice` selects `status, total, created_by` and **never
reads `kind`**. A credit note is a row in `accounting.invoice` with `kind = 'credit_note'`, and the
"you may not credit more than the invoice" cap lives *only* in `createCreditNote`
(`sales.ts:884-892`). There is no database constraint on the amount.

The sequence: issue INV for RM 1,000 → credit it in full (a RM 1,000 draft) → open
`/accounting/invoices/<creditNoteId>/edit`, which gates on status only
(`invoices/[id]/edit/page.tsx:24`) → change the line to RM 10,000 and the customer → submit,
approve, issue. `issueInvoice` posts the credit journal on the `kind === "credit_note"` branch
(`sales.ts:700`) with no re-check. Result: a RM 10,000 revenue reversal and a RM 9,000 credit
balance against a customer who was never invoiced.

**Fix:** `updateInvoice` must read `kind` and, for a credit note, re-apply the cap against
`creditedSoFar` — and the edit screen must not offer a credit note the invoice form.

### 2.2 A quotation can be accepted by the person who raised it

`packages/core/src/sales.ts:259` — `decideQuotation` requires `accounting.quotation.create`, not
`accounting.quotation.approve`, and calls no `requireDifferentApprover`.
`apps/staff/src/app/accounting/sales-actions.ts:124` passes `quotation.create` for *every* branch,
including accept and convert.

`packages/db/src/rbac.ts` declares `["accounting.quotation.create","accounting.quotation.approve"]`
in `MAKER_CHECKER_PAIRS`, and `docs/RBAC_MATRIX.md` grants `quotation.approve` selectively. **Both
are false statements about the running system.** `accounting.quotation.approve` gates nothing.

### 2.3 The second factor has no attempt limit

`packages/core/src/session.ts:186` — `completeMfa` neither reads nor increments
`auth."user".failed_attempts`. An attacker who already has the password (so holds a pre-MFA session
cookie) may submit codes to `/login/mfa` without limit: three valid TOTP values per 30-second
window, plus ten live recovery codes, against a 12-hour session. `AUDIT.MFA_FAILED` is written and
nothing reads it.

The account lockout `docs/SECURITY_MODEL.md` promises exists on the password and **not at all on the
second factor**.

### 2.4 The session token is not rotated when MFA completes

`packages/core/src/session.ts:207` — `completeMfa` only sets `mfa_satisfied_at` on the existing row.
A pre-MFA token that was fixed, copied or observed becomes a fully MFA-satisfied session the moment
the legitimate user completes TOTP. `docs/SECURITY_MODEL.md` §2 explicitly requires rotation "on
login, MFA completion and privilege change"; only login rotates.

### 2.5 `mfa_enforced` is written, displayed, and never enforced

`packages/core/src/session.ts:134` decides MFA purely on whether a *confirmed* authenticator exists
(`userHasConfirmedMfa`). The `mfa_enforced` column is selected and ignored.

**Verified in the browser:** an account created with "Require an authenticator app" ticked signed in
with a password alone and reached all 124 of its capabilities, while `/account` displayed *"Your
role requires an authenticator and none is enrolled."* The platform states a requirement it does not
impose.

### 2.6 The approver of a legal document cannot open it

`apps/staff/src/app/cases/[id]/documents/[docId]/pdf/route.ts:29` and `docx/route.ts:22` both
require `case.document.generate`. DIRECTOR's bundle is `readOnlyOf("case.")` plus
`case.document.approve` — **no `generate`**. A director asked to approve a generated application is
redirected to `/denied?capability=case.document.generate`.

`case.document.download`, which exists for exactly this, gates nothing.

### 2.7 A recovery code can be spent twice

`packages/core/src/session.ts:218` — the `SELECT ... WHERE used_at IS NULL` has no `FOR UPDATE` and
runs on the pooled handle rather than in a transaction. Two simultaneous posts of the same code both
pass the select and both mark the session satisfied. `enrolment.ts:49` and `:183` do take
`FOR UPDATE`, so the pattern was known.

### 2.8 A setting's value is written to the audit trail verbatim

`packages/core/src/settings.ts:143` — `oldValues: { key, value: row.value }`. `redact()` keys on the
*property name*, and the property is literally `value`, which is in neither the sensitive nor the
masked list. The first credential stored as a setting — a MyInvois client secret, an API key — is
copied in plaintext into an append-only table that cannot be scrubbed.

---

## 3. Incomplete functionality

- **A draft quotation cannot be edited or deleted.** `apps/staff/src/app/accounting/quotations/[id]/QuotationActions.tsx:44` offers only "send". `saveQuotation` has an update branch that nothing reaches. Every comparable document (invoice, voucher, PO, claim, journal) has an edit route.
- **`expired` is a quotation status nothing can reach.** `valid_until` is computed, stored and displayed, the trigger permits `sent → expired`, and no code sets it. Worse, `decideQuotation` and `convertQuotationToInvoice` never read it: a quotation that lapsed a year ago converts silently.
- **Only full credit notes can be raised.** `createCreditNote` accepts a `lines` array for a partial credit; `sales-actions.ts:222` never passes it. Crediting one line — the common case — has no screen.
- **No customer-facing document for a quotation, receipt, voucher or purchase order.** Only invoices, payslips, letters and case documents have a PDF route. A quotation advances to `sent` and an issued PO commits the firm to a supplier, with nothing to send.
- **e-Invoice has no submission path at all.** `buildEInvoiceDocument` (`einvoice.ts:496`) has zero callers repo-wide; `provider.submit()` is called only from tests. Beyond the documented Q-FIN-2 refusal: even with a TIN, client id, secret and environment supplied, nothing invokes the provider, no column records a submission id or status, and the invoice line form has no classification code field the adapter requires.
- **Revenue cannot be attributed to a case from any screen.** `invoice_line.case_id` and `quotation_line.case_id` are accepted, computed, persisted and carried through conversions and credit notes — and `readLines` never reads a `caseId`, no form renders one, and no report uses it. For a firm that bills per matter, this is the missing link between the two halves of the platform.
- **`audit.export` gates nothing.** No export control or CSV route exists on `/admin/audit`, though three roles are granted the capability.
- **An authorisation denial is never recorded**, while `apps/staff/src/app/denied/page.tsx:27` tells the user "The request has been recorded." There is no `ACCESS_DENIED` audit action.
- **`AUDIT.SESSION_REVOKED` is declared and unused** — `revokeSession` writes `LOGOUT`, so a user killing a suspicious device is indistinguishable from that device signing out.
- **No audit row on successful MFA, or on a recovery code being spent** — the success paths return before `writeAudit`.

## 4. Capabilities that gate nothing

Seven of 127 keys are checked nowhere in `apps/staff` or `packages/core`. Each is a false statement
in `docs/RBAC_MATRIX.md`, which is the document somebody reads to decide who may do what. This is
the same class as the `template.*` family already removed in migration 0026.

`accounting.einvoice.submit` · `accounting.einvoice.cancel` · `accounting.quotation.approve` ·
`admin.integration.manage` · `audit.export` · `case.document.download` · `hr.schedule.view`

## 5. Dangerous defaults

`getSetting` returns its fallback when the row is absent **or when the value is null** — and
`needs_review` settings are seeded deliberately null. So any call site passing a non-null fallback
silently defeats the "refuse rather than guess" discipline:

| Setting | Fallback | What it silently asserts |
|---|---|---|
| `accounting.fiscal_year_start_month` | `1` | A January fiscal year for a company whose year may start in any month |
| `accounting.aging_buckets` | `[30,60,90]` | CAC's receivables policy, on a report that drives collections |
| `accounting.quotation_validity_days` | `30` | A contractual date on a customer-facing offer |
| `company.registration_no` | `""` | A statutory payslip issued with no registration number |
| `company.name` / `company.address` | hardcoded / `""` | A court-facing estate document emitted with an empty address |

Failing closed correctly, for contrast: `accounting.approval_threshold_myr` → null forces the
high-value capability; `cases.age_of_majority` → null disables the age check;
`cases.legal_reviewer_confirmed` → false blocks legal approval.

## 6. Unreachable code

- `packages/core/src/accounts.ts:125` — `getAccount`, no callers repo-wide.
- `packages/core/src/receipts.ts:411` — `suggestAllocation`, referenced only by its test. The "here are the invoices this receipt probably pays" suggestion is built, tested, and never offered.
- `packages/core/src/einvoice.ts:496` — `buildEInvoiceDocument`, no callers including tests.
- `packages/core/src/session.ts:326` — `changePassword`, no callers, and it writes a new hash **without revoking sessions**, violating the rule its own module documents.
- `apps/staff/src/lib/nav.ts:21` — the `phase` field and its comment are now dead; no entry carries a marker.

## 7. Lower-severity findings

- **Account enumeration at sign-in.** The lock and status checks run *before* `verifyPassword` (`session.ts:90`, `:102`), so a suspended or locked account is distinguishable from an unknown one with any junk password. `login/actions.ts:58` claims the suspended message is safe "because the password was correct" — it was never checked.
- **`auth.login_attempt` is write-only.** Inserted on every attempt, indexed by IP, never selected. The per-IP backoff §2 promises does not exist: one guess each across 200 accounts from one address trips nothing.
- **A TOTP code is replayable for its ±1-step window (~90 s).** No used-step counter; `last_used_at` is written and never compared.
- **A lockout does not end live sessions.** `resolvePrincipal` checks `status` but not `locked_until`. Suspension revokes; locking does not.
- **Role changes do not rotate sessions**, contrary to §2. Impact is limited because capabilities re-resolve per request.
- **Recovery codes are hashed with their hyphen**; a user who types `ABCDEFGHIJ` instead of `ABCDE-FGHIJ` is rejected with a message identical to a wrong code.
- **No Content-Security-Policy or HSTS** on the staff app. Four other security headers are set; §7 requires a nonce-based CSP.
- **`netTotal` escapes the audit mask list** (`payroll.ts:753`, `:812`, `:955`) — `netpay`/`net_pay` are masked, `nettotal` is not, so a run's aggregate net pay is stored unmasked.
- **`reason` bypasses `redact()` entirely.** Every reason field is free text a user types, and `resetMfa` makes one mandatory; an identification number pasted into one lands unredacted in an append-only table.
- **The P&L buckets accounts by the leading digit of the code**, and nothing ties a code to its type. A `REVENUE` account coded `3900` or `REV-ADVISORY` — both accepted — lands in no section and vanishes from `netProfit`, while the trial balance still balances. The balance sheet then reports a difference and points the reader at the one report that looks correct.
- **`maskValue` returns the last four characters of a stringified number**, so `basic_salary: "3500.00"` masks to `***0.00` — weaker than the shape §4 describes.
- **The breached-password check named in §2 is absent**, and the code says so.
- **A stale banner after enrolment.** The action's returned page still says no authenticator is enrolled; a reload is correct. Cosmetic.

---

## 8. What this audit did not cover

- The remaining four slices in the table above were still running when this was written.
- No fix has been applied. Every finding above is a report, not a change.
- The browser pass exercised reads on all 52 screens and the full authentication chain. It did not
  complete a business transaction end to end through the UI — the write paths are covered by 711
  tests, but not yet by use.
