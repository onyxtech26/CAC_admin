# CAC — End-to-end audit findings

A full end-to-end check of the platform: the staff application driven in a real browser, and six
parallel code audits covering accounting, HR and payroll, estate cases, documents, the
cross-cutting security model, and the public site.

Every finding below has been **verified against the source**, not taken on report. Deliberate,
documented refusals (payroll without statutory tables, an empty checklist without approved rules,
an unconfigured scanner leaving a file in quarantine) are **not** listed as defects — they are
correct behaviour recorded in `docs/OPEN_QUESTIONS.md`.

Status: **five of six slices audited. Three defects fixed (§9); the rest are reported, not fixed.**

| Slice | Auditor | Status |
|---|---|---|
| Browser end-to-end (auth, every screen) | driven directly | ✅ |
| Accounting (Phases 2, 3a, 3b, 4) | agent | ✅ |
| Cross-cutting: auth, RBAC, audit, nav | agent | ✅ |
| HR and payroll (Phases 5–7) | agent | ✅ |
| Documents (8, 10, 12) | agent | ✅ |
| Public site (`apps/web`) | agent | ✅ |
| Estate cases and the agent (9, 11) | agent | **not done** — cut twice by the usage limit |

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

> **All eight are fixed**, in the pass after this audit, with regression tests in
> `packages/core/src/sales.test.ts` and `packages/core/src/session.test.ts`. Each entry keeps the
> original finding and ends with what was done. 731 tests pass.

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

**Fixed.** `updateInvoice` reads `kind`, refuses to move a credit note to another customer, and
re-applies the cap against `creditedSoFar` with the draft itself excluded from the sum. `issueInvoice`
checks it a third time, because that is the moment it stops being a document and becomes a posted
reversal of revenue, and because the cap has never existed in the database — every path that posts
should therefore carry it.

### 2.2 A quotation can be accepted by the person who raised it

`packages/core/src/sales.ts:259` — `decideQuotation` requires `accounting.quotation.create`, not
`accounting.quotation.approve`, and calls no `requireDifferentApprover`.
`apps/staff/src/app/accounting/sales-actions.ts:124` passes `quotation.create` for *every* branch,
including accept and convert.

`packages/db/src/rbac.ts` declares `["accounting.quotation.create","accounting.quotation.approve"]`
in `MAKER_CHECKER_PAIRS`, and `docs/RBAC_MATRIX.md` grants `quotation.approve` selectively. **Both
are false statements about the running system.** `accounting.quotation.approve` gates nothing.

**Fixed.** `decideQuotation` requires `accounting.quotation.approve`, and acceptance requires somebody
other than the person who raised it — acceptance rather than both, because acceptance is the decision
that becomes an invoice. The server action asks for the capability each branch needs instead of
`quotation.create` for all four. DIRECTOR gains `accounting.quotation.approve`, since a director
approves invoices and this is the same kind of act.

While in there: **an accepted quotation must not have lapsed.** `valid_until` was computed, stored,
displayed and read by nothing, so a quotation that expired a year ago converted silently at the price
it carried then. That was finding 3's second bullet; it is fixed here because it lives in the same
function.

### 2.3 The second factor has no attempt limit

`packages/core/src/session.ts:186` — `completeMfa` neither reads nor increments
`auth."user".failed_attempts`. An attacker who already has the password (so holds a pre-MFA session
cookie) may submit codes to `/login/mfa` without limit: three valid TOTP values per 30-second
window, plus ten live recovery codes, against a 12-hour session. `AUDIT.MFA_FAILED` is written and
nothing reads it.

The account lockout `docs/SECURITY_MODEL.md` promises exists on the password and **not at all on the
second factor**.

**Fixed.** A failed code increments the same `failed_attempts` counter the password step uses and
locks the same account — it is the same account being attacked — and the lockout also revokes the
half-authenticated session, so it cannot be waited out with the same cookie.

### 2.4 The session token is not rotated when MFA completes

`packages/core/src/session.ts:207` — `completeMfa` only sets `mfa_satisfied_at` on the existing row.
A pre-MFA token that was fixed, copied or observed becomes a fully MFA-satisfied session the moment
the legitimate user completes TOTP. `docs/SECURITY_MODEL.md` §2 explicitly requires rotation "on
login, MFA completion and privilege change"; only login rotates.

**Fixed.** `completeMfa` issues a new token and returns it, and the sign-in action replaces the
cookie. The session *row* is the same row, so there is still exactly one thing to revoke and the audit
chain is unbroken; only the bearer token changes. The old token stops resolving, which the test
asserts directly.

One consequence worth stating: the function used to return a boolean and now returns a result object,
so `if (!ok)` would have become always-false. The caller is a `switch`, and the type change made the
compiler find it.

### 2.5 `mfa_enforced` is written, displayed, and never enforced

`packages/core/src/session.ts:134` decides MFA purely on whether a *confirmed* authenticator exists
(`userHasConfirmedMfa`). The `mfa_enforced` column is selected and ignored.

**Verified in the browser:** an account created with "Require an authenticator app" ticked signed in
with a password alone and reached all 124 of its capabilities, while `/account` displayed *"Your
role requires an authenticator and none is enrolled."* The platform states a requirement it does not
impose.

**Fixed**, on the `must_change_password` pattern, which is the same shape of problem and already had
an answer. `resolvePrincipal` computes `mustEnrolMfa` — the account requires an authenticator and holds
none — and the route guard sends such a principal to /account until one is enrolled. /account stays
reachable so it can be; nothing else opens. Signing in still succeeds, because there is no second
factor to ask for yet, and a session that could not reach the enrolment screen would be a locked door
with the key inside.

The requirement now has two sources, because the document names two. `mfa_enforced` is the per-user
flag; `security.mfa_required_roles` is seeded with the six roles SECURITY_MODEL.md calls mandatory and
was, like the flag, read by nothing. Either one requires an authenticator, so unticking the box for a
director is not a way around the firm's own policy.

**This changes what happens at the next sign-in.** `mfa_enforced` defaults to true on every account
and `bootstrap` sets it explicitly, so an existing account without an authenticator will be sent to
/account to enrol one before anything else opens. That is the behaviour the platform has been claiming
all along; it is just now true.

Also fixed while here: the notice on /account said the requirement existed. It now says what happens.

730 tests → 731 with the role-policy test.

### 2.6 The approver of a legal document cannot open it

`apps/staff/src/app/cases/[id]/documents/[docId]/pdf/route.ts:29` and `docx/route.ts:22` both
require `case.document.generate`. DIRECTOR's bundle is `readOnlyOf("case.")` plus
`case.document.approve` — **no `generate`**. A director asked to approve a generated application is
redirected to `/denied?capability=case.document.generate`.

`case.document.download`, which exists for exactly this, gates nothing.

**Fixed.** The document's own page and both file routes gate on `case.document.download`, which now
gates something, and DIRECTOR and LAWYER_OR_AUTHORISED_REVIEWER hold it. The letters half of the same
defect (10.7) is fixed the same way: those routes accept `hr.letter.generate` or `hr.letter.approve`,
there being no `hr.letter.download` to grant.

### 2.7 A recovery code can be spent twice

`packages/core/src/session.ts:218` — the `SELECT ... WHERE used_at IS NULL` has no `FOR UPDATE` and
runs on the pooled handle rather than in a transaction. Two simultaneous posts of the same code both
pass the select and both mark the session satisfied. `enrolment.ts:49` and `:183` do take
`FOR UPDATE`, so the pattern was known.

**Fixed.** The whole of `completeMfa` is one transaction; the session and user rows are locked when
they are read, and the recovery code is selected `FOR UPDATE`. The test says honestly what it proves:
PGlite holds a single connection and serialises the two calls, so it demonstrates the logic and cannot
demonstrate the lock. Against a real PostgreSQL the same test exercises both.

### 2.8 A setting's value is written to the audit trail verbatim

`packages/core/src/settings.ts:143` — `oldValues: { key, value: row.value }`. `redact()` keys on the
*property name*, and the property is literally `value`, which is in neither the sensitive nor the
masked list. The first credential stored as a setting — a MyInvois client secret, an API key — is
copied in plaintext into an append-only table that cannot be scrubbed.

**Fixed, by refusing the premise.** `org.setting` is a plain jsonb column, readable by anybody with
settings access, copied verbatim into every backup, and copied into the audit trail — three places, one
of them permanent. It is not a secret store, so `setSetting` now refuses a key that reads like a
credential and says where such a value belongs instead. The audit payload redacts one anyway, as a
backstop for a key that slips past the pattern, and `client_secret`, `private_key` and `credential`
join the sensitive-key list that `redact()` works from.

---

## 3. Incomplete functionality

- ~~**A draft quotation cannot be edited or deleted.**~~ **Fixed:** an edit route, and a delete that asks why and keeps the audit row. `updateQuotation` and `saveQuotation`'s update branch both existed and nothing reached either.
- **`expired` is a quotation status nothing can reach.** `valid_until` is computed, stored and displayed, the trigger permits `sent → expired`, and no code sets it. Worse, `decideQuotation` and `convertQuotationToInvoice` never read it: a quotation that lapsed a year ago converts silently. **Half fixed:** accepting a lapsed quotation is now refused, naming the date it lapsed. Nothing yet *sets* the `expired` status, so the list still shows a lapsed quotation as sent; that is cosmetic beside the conversion, which was not.
- ~~**Only full credit notes can be raised.**~~ **Fixed:** the credit form lists the invoice's lines, each at its full value and reducible, and carries each line's account, tax code and matter through so the credit reverses what it credits rather than landing somewhere else.
- ~~**No customer-facing document for a quotation, receipt, voucher or purchase order.**~~ **Fixed:** all four, through one layout. `invoice-pdf.ts` was a two-hundred-line layout welded to `InvoiceView`; it is now an adapter onto `document-pdf.ts`, which draws every document the firm sends, so there is one layout rather than five copies. Each route refuses a document that has not been issued, approved or posted — a file with DRAFT across it is not one to hand anybody.
- **e-Invoice has no submission path at all.** `buildEInvoiceDocument` (`einvoice.ts:496`) has zero callers repo-wide; `provider.submit()` is called only from tests. Beyond the documented Q-FIN-2 refusal: even with a TIN, client id, secret and environment supplied, nothing invokes the provider, no column records a submission id or status, and the invoice line form has no classification code field the adapter requires.
- ~~**Revenue cannot be attributed to a case from any screen.**~~ **Fixed, all three ends:** `readLines` reads it, the invoice and quotation forms offer a matter per line (scoped by `listCases`, so the form cannot become a way to enumerate matters), and `matterRevenue` reports what each matter has billed, what it has outstanding and what has been accepted and not yet billed. Credit notes net off, because a credit note carries the matter through. Outstanding is apportioned by line value and described as a share rather than a debt: a receipt pays an invoice, not a line, so a split invoice half paid cannot say which half.
- ~~**`audit.export` gates nothing.**~~ No export control or CSV route exists on `/admin/audit`, though three roles are granted the capability. **Fixed:** a date-ranged CSV route and the control that reaches it. The export is itself audited with the range and the row count, because an export is the moment the trail leaves the platform. Old and new values are left out — they are redacted already, and a file of every payload is a file of masked personal data; the reason, which is the part that explains a change, is included. Cells beginning `=`, `+`, `-` or `@` are prefixed, so a reason somebody typed cannot execute in the reviewer's spreadsheet.
- ~~**An authorisation denial is never recorded**~~, while `apps/staff/src/app/denied/page.tsx:27` tells the user "The request has been recorded." There is no `ACCESS_DENIED` audit action. **Fixed:** there is one now, written by both route guards, with the capability and the caller's roles. A failure to write it is swallowed — a denial that cannot be logged must still be a denial.
- ~~**`AUDIT.SESSION_REVOKED` is declared and unused**~~ — `revokeSession` writes `LOGOUT`, so a user killing a suspicious device is indistinguishable from that device signing out. **Fixed:** `revokeSession` takes a reason, and the device list passes "revoked". The two are different events: one is somebody leaving, the other is somebody noticing.
- ~~**No audit row on successful MFA, or on a recovery code being spent**~~ — the success paths return before `writeAudit`. **Fixed:** `MFA_SATISFIED` records which of the two was used. Failures without successes are unreadable, since there is nothing to compare them against.

## 4. Capabilities that gate nothing

Seven of 127 keys are checked nowhere in `apps/staff` or `packages/core`. Each is a false statement
in `docs/RBAC_MATRIX.md`, which is the document somebody reads to decide who may do what. This is
the same class as the `template.*` family already removed in migration 0026.

`accounting.einvoice.submit` · `accounting.einvoice.cancel` · ~~`accounting.quotation.approve`~~ ·
`admin.integration.manage` · `audit.export` · ~~`case.document.download`~~ · `hr.schedule.view`

Two of them now gate something, as a consequence of 2.2 and 2.6: `accounting.quotation.approve` gates
accepting a quotation, and `case.document.download` gates reading a generated case document. Five
remain, and the same choice applies to each — wire it up or remove it, because a capability that gates
nothing is a line in the matrix that is not true.

## 5. Dangerous defaults

`getSetting` returns its fallback when the row is absent **or when the value is null** — and
`needs_review` settings are seeded deliberately null. So any call site passing a non-null fallback
silently defeats the "refuse rather than guess" discipline:

> **Three of the five are fixed**, and the fix is in two parts: `getSettingState` tells a caller
> whether a value was actually confirmed, and `needs_review` — which several of these carry and
> which nothing downstream ever read — now reaches the screens. Migration 0032 flags the two that
> leave the platform.

| Setting | Fallback | What it silently asserts |
|---|---|---|
| `accounting.fiscal_year_start_month` | `1` | A January fiscal year for a company whose year may start in any month — **fixed:** the notice now appears when the month is unconfirmed rather than when it happens to be January, which was both a false alarm and a missed one |
| `accounting.aging_buckets` | `[30,60,90]` | CAC's receivables policy, on a report that drives collections — **fixed:** the report carries `boundariesConfirmed` and says on its face when the boundaries are the platform's suggestion |
| `accounting.quotation_validity_days` | `30` | A contractual date on a customer-facing offer — **fixed:** an unconfirmed setting means the quotation states *no* validity, rather than implying a deadline nobody set. That mattered more once accepting a lapsed quotation became a refusal |
| `company.registration_no` | `""` | A statutory payslip issued with no registration number |
| `company.name` / `company.address` | hardcoded / `""` | A court-facing estate document emitted with an empty address |

Failing closed correctly, for contrast: `accounting.approval_threshold_myr` → null forces the
high-value capability; `cases.age_of_majority` → null disables the age check;
`cases.legal_reviewer_confirmed` → false blocks legal approval.

## 6. Unreachable code

- ~~`packages/core/src/accounts.ts:125` — `getAccount`, no callers repo-wide.~~ **Removed.**
- `packages/core/src/receipts.ts:411` — `suggestAllocation`, referenced only by its test. The "here are the invoices this receipt probably pays" suggestion is built, tested, and never offered. **Fixed, and it was worse than unreachable:** the allocation form had its own copy of the rule, which sorted on the *formatted* date — so "oldest first" ordered the invoices alphabetically by month name and put December before February. The client copy is gone and the button applies the server's suggestion.
- `packages/core/src/einvoice.ts:496` — `buildEInvoiceDocument`, no callers including tests.
- ~~`packages/core/src/session.ts:326` — `changePassword`, no callers, and it writes a new hash **without revoking sessions**, violating the rule its own module documents.~~ **Removed** rather than fixed: `changeOwnPassword` is the one in use and it does revoke them. A second, subtly weaker way to do the same thing is how the weaker one eventually gets called.
- `apps/staff/src/lib/nav.ts:21` — the `phase` field and its comment are now dead; no entry carries a marker.

## 7. Lower-severity findings

> **Nine of thirteen are fixed**, with migration 0031 and tests in `session.test.ts`,
> `authz.test.ts` and `hardening.test.ts`. Each is marked below. 749 tests pass.

- **Account enumeration at sign-in.** The lock and status checks run *before* `verifyPassword` (`session.ts:90`, `:102`), so a suspended or locked account is distinguishable from an unknown one with any junk password. `login/actions.ts:58` claims the suspended message is safe "because the password was correct" — it was never checked. **Fixed:** both checks now run after the password is verified, so the state of an account is disclosed only to somebody who holds it. The hash still runs first and always, so the timing is unchanged.
- **`auth.login_attempt` is write-only.** Inserted on every attempt, indexed by IP, never selected. The per-IP backoff §2 promises does not exist: one guess each across 200 accounts from one address trips nothing. **Fixed:** twenty failures from one address in fifteen minutes refuses that address, before the account lookup, so the refusal cannot itself be used to ask questions. Both figures are on `LoginPolicy`.
- **A TOTP code is replayable for its ±1-step window (~90 s).** No used-step counter; `last_used_at` is written and never compared. **Fixed:** migration 0031 adds `last_step`, `matchTotpStep` returns which step matched, and a step at or below the last accepted one is not a match at all — so the caller cannot accept a replay by ignoring a flag.
- **A lockout does not end live sessions.** `resolvePrincipal` checks `status` but not `locked_until`. Suspension revokes; locking does not. **Fixed:** a locked account's sessions are revoked as they are resolved. (A related bug found while fixing it: the failed-login branch wrote `locked_until = null` on every attempt that did not trip the limit, so a locked account unlocked itself on the next wrong guess.)
- **Role changes do not rotate sessions**, contrary to §2. Impact is limited because capabilities re-resolve per request.
- **Recovery codes are hashed with their hyphen**; a user who types `ABCDEFGHIJ` instead of `ABCDE-FGHIJ` is rejected with a message identical to a wrong code. **Fixed:** `normaliseRecoveryCode` strips everything that is not a letter or a digit, at generation and at verification, so the hyphen is presentation and a pasted space does not matter.
- **No Content-Security-Policy or HSTS** on the staff app. Four other security headers are set; §7 requires a nonce-based CSP. **Fixed:** `apps/staff/src/middleware.ts` sets a nonce-based CSP with `strict-dynamic`, and HSTS only over HTTPS — sending it on a plain-HTTP development origin would pin localhost for a year. `style-src` keeps `unsafe-inline` because React writes inline style attributes and a nonce does not cover attributes; `'unsafe-eval'` is added in development only, for React Refresh. Verified in the browser: the page hydrates, the server action returns, and the console is clean.
- **`netTotal` escapes the audit mask list** (`payroll.ts:753`, `:812`, `:955`) — `netpay`/`net_pay` are masked, `nettotal` is not, so a run's aggregate net pay is stored unmasked.
- **`reason` bypasses `redact()` entirely.** Every reason field is free text a user types, and `resetMfa` makes one mandatory; an identification number pasted into one lands unredacted in an append-only table. **Fixed:** `redactFreeText` removes the two shapes that are unmistakable and irreversible — a Malaysian NRIC, and a run of ten or more digits — and nothing else. Narrow on purpose: a filter that mangled ordinary sentences would make people write less rather than less sensitive.
- **The P&L buckets accounts by the leading digit of the code**, and nothing ties a code to its type. A `REVENUE` account coded `3900` or `REV-ADVISORY` — both accepted — lands in no section and vanishes from `netProfit`, while the trial balance still balances. The balance sheet then reports a difference and points the reader at the one report that looks correct. **Fixed:** revenue and expense come from the account's *type*, and the code only subdivides the expenses. Anything outside the numbering appears under a heading that says so, so nothing can fall out of the statement.
- **`maskValue` returns the last four characters of a stringified number**, so `basic_salary: "3500.00"` masks to `***0.00` — weaker than the shape §4 describes. **Fixed:** an amount, or any run of fewer than ten digits, is masked whole. The last four of an account or an NRIC stay, because that is a deliberate partial identifier and the reason `bank_account_last4` is a column.
- **The breached-password check named in §2 is absent**, and the code says so.
- **A stale banner after enrolment.** The action's returned page still says no authenticator is enrolled; a reload is correct. Cosmetic. **Addressed rather than fixed:** revalidating would re-render the page and take the one-time recovery codes with it, which is worse. The codes panel now says the banner above is out of date and why, beside the link that refreshes.

---

## 8. What this audit did not cover

- The remaining four slices in the table above were still running when this was written.
- No fix has been applied. Every finding above is a report, not a change.
- The browser pass exercised reads on all 52 screens and the full authentication chain. It did not
  complete a business transaction end to end through the UI — the write paths are covered by 711
  tests, but not yet by use.


---

# Part two — the remaining slices

## 9. Fixed in this pass

Three defects in the template engine, which both employment letters and case documents render
through. Fixed, with regression tests (`packages/core/src/letters.test.ts`, final describe). 715
tests pass.

### 9.1 A variable whose name began with a keyword was parsed as a keyword

`packages/core/src/templates.ts:58` — `BLOCK` used `\s*` between the keyword and its key, so the
keyword ran straight into an ordinary name. Verified by running the regex: `{{elsewhere}}` →
`['else', 'where']`, `{{else_note}}` → `['else', '_note']`, `{{#ifactive}}` → `['#if', 'active']`.

A declared variable called `elsewhere` therefore behaved as a branch marker, and — worse — an
*undeclared* placeholder sitting beside one was consumed before the undeclared-placeholder check
could see it. That check is the single thing the module exists to do. **Fixed** with a negative
lookahead so a keyword must be followed by something that cannot continue a name.

### 9.2 A malformed tag was rendered literally into a signed document

`{{#ifactive}}` (a missing space) matched neither a placeholder nor a block, so it passed validation,
passed the undeclared check, was never resolved, and was printed verbatim into the stored
`body_rendered` — and from there into the DOCX and PDF that reach an employee or a registry.
**Fixed:** `validateTemplateBody` now refuses any `{{…}}` that is neither shape, and does so
*first*, so the message names the typo rather than complaining about the unmatched `{{/if}}` it
caused.

### 9.3 A figure the letter did not contain was demanded before it could be

`packages/core/src/templates.ts:160` — the required-value check ran *before* `resolveConditionals`,
so a variable used only inside a conditional was demanded even when the branch was false. The
comment two lines below claimed the opposite ordering.

This made the module's own shipped example unusable: the appointment-letter body in
`LetterForms.tsx` declares `car_allowance` inside `{{#if has_car_allowance}}`, so generation was
refused whenever the allowance did not apply. Marking it optional only moved the failure — the
clause then rendered as "a car allowance of RM  per month", the exact outcome the module's header
disclaims. **Fixed:** conditionals resolve first, and a value is required only if its placeholder
survives into the document.

---

## 10. Further blocking defects — documents (Phases 8, 10, 12)

### 10.1 Reading a finalised document destroys its text, irrecoverably

`packages/core/src/library.ts:722` — "Read and index it" appears whenever a document is `readable`,
which a finalised case-document PDF is. Pressing it runs `extractAndIndex`, which sees
`application/pdf`, returns `needs_ocr`, and then **deletes the page text and chunks that
finalisation had supplied** and nulls `extraction_method`, `page_count`, `text_chars` and
`extracted_at`.

The text cannot be restored: `finaliseCaseDocument` refuses a second run, the generated document is
immutable by trigger, and no other path re-supplies page text. One path refuses to read a PDF;
another silently erases text that was already there.

### 10.2 `storeFinalisedPdf` writes `scan_status = 'clean'`

`packages/core/src/case-documents.ts:895` — it sets `clean` with `scanner = 'internal:generated'`,
while the library's own migration comment, `scanning.ts`, and **this function's own docstring** all
say the word `clean` is never borrowed. The docstring claims the row says something "much more
honest than borrowing the word 'clean'". It borrows the word.

This is my own design, and the auditor is right: the intent was a distinct state, and what shipped
reuses `clean` because that is what the downstream gates check. It is also what makes 10.1
reachable. A `produced_internally` status, accepted by the same gates, is the honest fix.

### 10.3 A boolean means three different things

`letters.ts:551` coerces anything that is not `"false"`, `"0"` or `""` to **true**;
`case-documents.ts:717` uses an allow-list (`true|yes|y|1|on`); `templates.ts:241` treats `"no"` as
false. So the value `"no"` produces a letter whose `{{#if flag}}` clause is **included** and whose
`{{flag}}` prints `"yes"`, and a case document where both are negative.

### 10.4 A DOCX deflate bomb can exhaust the server

`packages/core/src/extraction.ts:330` — `inflateRawSync(data)` with no `maxOutputLength`. Node's
default is ~4 GiB, so a few megabytes of zeros inside the 25 MB upload limit (deflate reaches
~1032:1) allocates gigabytes inside the request, then runs six global regex passes over the result.
The central directory's *uncompressed* size is never read, so nothing bounds the output.

### 10.5 A lying ZIP entry reports a successful read of nothing

`packages/core/src/extraction.ts:327` — `subarray(dataAt, dataAt + compressedSize)` trusts the
declared size. A stored entry that overstates it yields whatever bytes follow; `decodeText` produces
text with no `<w:t>` elements, and `extractText` reports `status: "extracted"`, `confidence: 1`, and
"Read from the document's own text runs" over an **empty string**. `NotConfiguredOcrEngine` refuses
precisely because "an empty page is indistinguishable from a blank document"; this path does exactly
what that refuses to do.

**Fixed, in both halves.** An entry whose declared size runs past the end of the file is refused
rather than silently clamped, and a Word document that yields no text runs at all is reported as
`unsupported` with the reason, instead of as a successful read of nothing.

### 10.6 `matterTypes` is interpolated into a Postgres array literal

`packages/core/src/case-documents.ts:177` — built by string concatenation from
`form.getAll("matterTypes")` with no allow-list. A posted value `probate","la` becomes two elements;
a value containing a quote or backslash produces a malformed literal and an opaque 500. It is a
bound parameter, so this is array-literal injection rather than SQL injection — but it lets a
template claim matter types the UI never offered, and an unrecognised value makes that template
permanently unusable, since the trigger then refuses every generation.

### 10.7 The letters half of the approver-cannot-read defect

Extends §2.6. **Every** screen and route in the letters and case-document slice is gated on the
*generate* capability, while the approve buttons are gated on *approve*. DIRECTOR holds
`hr.letter.approve` and `case.document.approve` and neither `.generate`, so a director is redirected
to `/denied` and can never read, approve, or open the PDF of a letter or a case document.
`requireAnyCapability` exists for exactly this and is used on the case pages but not here.

---

## 11. Further blocking defects — HR and payroll (Phases 5–7)

> **Fixed, in the pass after this audit.** 11.1 through 11.7 are all repaired, with migrations 0027,
> 0028 and 0029 and regression tests in `packages/core/src/payroll.test.ts` ("the defects the
> end-to-end audit found", and the rewritten reproducibility test) and
> `packages/core/src/hr-workflows.test.ts` ("a refused claim, and a rate that arrives late"). 724
> tests pass (715 before this pass). Each entry below keeps the original finding and ends with what was done. 11.8 and the
> items under 11.9 are **not** fixed; 11.8 turned out to be a policy question and is now Q-HR-4.
>
> One thing the fix exposed, **since settled**: whether an overtime payment counts as wages for EPF,
> SOCSO/EIS and PCB. Three answers rather than one — not EPF, yes SOCSO and EIS, yes PCB — seeded as
> settings by migration 0034 and named on every overtime payslip line. See Q-HR-1 item 7.

### 11.1 A supplementary payroll run pays the whole month a second time

`packages/core/src/payroll.ts:237` — `preparePayrollRun` never reads `run.kind` or
`corrects_run_id`; both are written and read nowhere. The duplicate-period guard applies to
`kind = 'regular'` only.

`PayrollForms.tsx:47` calls a supplementary run "how a correction is made". Finalise March, create a
supplementary run naming it, and prepare produces a fresh **full** payslip for everyone employed in
March — full basic, full allowances, full statutory deductions. Posting debits salaries again. The
advertised correction mechanism is a double payment.

**Fixed.** A supplementary run now pays only what the run it corrects missed: the period's unclaimed
rated overtime, and the statutory contributions those additional wages attract. No basic salary, no
allowances, `payable_days` nought, and anybody with nothing outstanding is skipped with the reason
rather than given a payslip. It also validates what it is correcting — same period, and a run that has
actually been finalised or posted.

The contributions are the harder half. A contribution is on the month's wages, not on a payment, and
SOCSO, EIS and PCB are read out of band tables: applying the table to RM 300 of overtime gives the
contribution of somebody earning RM 300 a month. So migration 0028 records on each payslip the wage
base each contribution was computed on (`epf_wages`, `socso_wages`, `pcb_wages` — also a
reproducibility gap in its own right), and a correction computes the contribution on the combined
wages and subtracts what the period has already contributed, summed across every finalised run for
that period so a second correction corrects the month rather than one earlier run. Where a payslip
predates 0028 and has no base, the correction **refuses** and says so on the payslip rather than
guessing.

### 11.2 Finalising claims overtime the run never paid

`packages/core/src/payroll.ts:788` — the `UPDATE hr.overtime_request SET payroll_run_id = …` matches
every approved, rated, unclaimed claim in the period **at finalise time**, not the claims that were
on a payslip. A claim rated after the run was prepared is stamped with that run's id, becomes
invisible to every future run's `payroll_run_id IS NULL` filter, and is never paid. The hours are
silently lost and no screen shows it.

**Fixed.** Migration 0027 puts `overtime_request_id` on `hr.payslip_line`, with a foreign key, a
partial unique index so one claim can be paid by one line only, and a CHECK that only an earning line
may name a claim. `preparePayrollRun` records it; `finalisePayrollRun` claims exactly the ids its own
payslip lines name, and the period no longer comes into it. The count claimed goes on the audit entry.

### 11.3 An approved overtime claim can never be given a rate

`packages/core/src/overtime.ts:243` — `rate_multiple` is written in exactly one place,
`decideOvertime`, which refuses unless the status is `submitted`. There is no cancel, no re-decide,
and no other writer. The overtime screen renders a standing queue — "The hours are agreed; only the
rate is missing" — that **nothing in the codebase can drain**.

This is not the documented Q-HR-1 refusal. Approving hours without a rate is correct; having no exit
once CAC supplies the multiples is not. Every claim approved before the answer arrives is
permanently unpayable.

**Fixed.** `rateOvertime` in `packages/core/src/overtime.ts`, with `rateOvertimeAction` and an
`OvertimeRate` control in the last column of the overtime table, where the "not set" badge already
was. It is deliberately not a re-approval: the hours are not reopened and the approver is not
re-recorded, only the multiple and its source, and only while payroll has not taken the claim — after
that the database refuses and the route is a supplementary run. The same self-approval rule applies as
for deciding.

### 11.4 Unpaid leave across a month boundary is deducted twice

`packages/core/src/payroll.ts:343` — the query sums `r.days`, the whole request's count, for any
request merely *overlapping* the period. Leave of 27 Feb–4 Mar with `days = 5` is deducted as five
days from February **and** five from March.

Two further inconsistencies in the same arithmetic: `r.days` counts *working* days while the
proration denominator counts *calendar* days, so numerator and denominator are different units; and
one unpaid day costs 1/31 of a month in a 31-day month and 1/28 in February.

**Fixed** for the first two: the query clips each request to the period and counts calendar days, so
27 February–4 March costs three days in March and four in February, and the numerator is now in the
same unit as the denominator. The third is a policy choice rather than a defect — a month's salary over
the days in that month is the basis the module already applies to joiners and leavers, the payslip
states which basis it used, and Q-HR-4 now asks CAC to confirm the divisor.

### 11.5 Reproducibility is broken by four undated fields

`packages/core/src/payroll.ts:268` — salary correctly comes from dated history and rules correctly
come from the version in force, but `epf_applicable`, `socso_applicable`, `eis_applicable` and
`pcb_applicable` are read from `hr.employee` **as it stands today**, and they decide which
contributions are computed and which rule tables are demanded. `hr.employment_event` has no column
for them, so a change is undated and retroactive: re-prepare March after switching someone's PCB on
and March gains a deduction it never had. `department_name`, `position_title` and the bank fields are
snapshotted from the current row too.

This is the one promise Phase 7 was built to keep, and it holds only for the salary and the rates.

**Fixed** for the four that decide money. Migrations 0027 and 0029 put the flags on
`hr.employment_event`, nullable, projected onto the employee row with COALESCE exactly as employment
type and salary already are; the run reads them as at the end of the period. Both halves were needed:
`createEmployee` records them on the opening `hired` event, and `updateEmployee` writes a dated
`statutory_changed` event whenever one changes — without that second half the dated read would have
been *worse* than what it replaced, because the opening event would have answered for every period
after the joining day and a change on the employee record would have affected nothing at all.

(Migration 0027's own backfill used `kind = 'joined'`, which the kind CHECK does not permit. It
matched no rows, because migrations run before there are employees, so it failed silently rather than
loudly; 0029 does what it intended and says so.)

`department_name`, `position_title` and the bank fields remain snapshots of the current row. They are
descriptive rather than computational — no figure depends on them — and dating them is a larger change
than this pass warranted.

### 11.6 A period can be finalised before the engine has ever run

`packages/core/src/attendance.ts:1051` — `finaliseAttendancePeriod` checks only for a clock-in with
no clock-out. Import writes `worked_minutes` NULL; `recalculateAttendance` skips final rows by
design. Import March, finalise without pressing Recalculate, and `attendanceSummary` reports 0
worked, 0 late, 0 extra minutes for a fully attended month. The only remedy is reopening the period.

**Fixed.** `finaliseAttendancePeriod` refuses while any draft day in the period has no
`worked_minutes`, which covers both cases that produce one: the engine has never run, and a correction
cleared the figures afterwards on purpose. The message says to run the calculation first.

### 11.7 A rejected overtime claim blocks that date forever

`packages/core/src/overtime.ts:138` — the duplicate check matches any row for the employee-day
regardless of status, and there is no cancel, withdraw or delete. A claim rejected for a wrong figure
cannot be re-submitted: "There is already a rejected overtime request for that day." Leave has
`cancelLeave`; overtime has no equivalent.

**Fixed.** The check ignores rejected rows, and migration 0028 replaces the
`UNIQUE (employee_id, work_date)` constraint — which enforced the same thing one layer down, so fixing
only the application check would have changed nothing — with a partial unique index excluding rejected
rows. One *live* claim per person per day, which is the guarantee that was actually wanted.

### 11.8 Attendance feeds nothing into payroll

`packages/core/src/payroll.ts:186` — `hr.attendance` is read once in the whole module, to count draft
days, and the count is used only in an audit payload. So: an `is_absent` day does not reduce pay,
lateness and short days do not, and `approved_ot_minutes` on the attendance row is ignored — only the
separately approved overtime request is paid. Finalising attendance is, as far as payroll is
concerned, ceremonial. Both modules' comments claim otherwise.

**Not fixed, and now a question rather than a defect: Q-HR-4.** Deducting a day's pay for an
unauthorised absence is taking money from somebody, and what lateness costs ranges from nothing to a
deduction the Employment Act constrains. Neither is a rule this platform may invent, so it is asked
rather than guessed.

Two things were done in the meantime. `preparePayrollRun` now **refuses** a period whose attendance is
still a draft — which the comment claimed and the code did not check; the draft count was read into an
audit payload and ignored. And the misleading comments are gone. So a month is closed and looked at
before it is paid, whatever the answer turns out to be.

### 11.9 Incomplete, HR

- **An appraisal cycle cannot be closed.** `'closed'` is in the type and the CHECK constraint, and
  nothing writes it. There is also no way to send a review back for revision.
- **`statutorySummary` is on no screen** — called only from its test. The monthly EPF/SOCSO/EIS/PCB
  return figures cannot be produced by a user, though `OPEN_QUESTIONS.md` lists the summary as
  working.
- **Inconsistent refusal on the overtime rate.** The module refuses to guess the Employment Act
  multiple and silently picks the 208-hour divisor that converts monthly salary to hourly. Both
  halves of the product are equally unsourced; one refuses and one guesses, and the guess is stamped
  into the payslip basis line as though established.
- **A staged import cannot be re-resolved** after an unmapped device number is fixed: the staged rows
  keep `employee_id = NULL`, and confirm writes only matched rows. The file must be discarded and
  re-uploaded, and no screen says so.
- **`attendanceToday` and `leaveForEmployee`** have no callers and are not exported from the barrel.

### 11.10 Privacy

`payroll.ts:756`, `:812`, `:955` — `netTotal` reaches the audit table unmasked. `redact()` masks
`net_pay` and `gross_pay`, not `nettotal`. On a single-employee run — which is the documented
correction path — the audit row is that person's net pay in the clear.

Everything else in HR checks out and was verified: the NRIC and bank account are truncated *and*
masked, `getEmployeeSensitive` records the field names and the stated reason and never the values,
and the payslip path receives only the last four digits.

---

## 12. The public site (`apps/web`)

> **Fixed**, apart from four unused asset files and the hand-written `sitemap.xml` date, both noted
> at the end. The enquiry form now writes to the platform rather than to a `mailto:`, which needed a
> table, a public endpoint and a screen; the rest is the soft 404, the accessibility barriers and the
> content errors.

### 12.1 There is no enquiry form anywhere on the site

`apps/web/src/pages/Contact.tsx` renders a consultant roster and four contact cards. There is no
name, email or message field and no submit button. **Every primary call to action on the site points
here** — "Start Investigation", "Book Consultation", "Engage this discipline", and every Contact
link. A visitor who clicks the main CTA arrives somewhere they can only leave the site for WhatsApp
or open a mail client.

`apps/web/src/data.ts:322` — `SERVICE_OPTIONS`, the six service titles, is exported and referenced by
**zero** components. It is the dropdown source for the form that was never built, which is what makes
this outstanding work rather than a deliberate omission.

Confirmed by sweep: zero `<form>`, zero `onSubmit`, zero `fetch`, zero `FormData` in the whole site.
So nothing a visitor types is silently discarded — because there is nowhere to type anything. The
only data-out channels are `mailto:`, `tel:` and `wa.me`.

**Fixed, as a pipeline rather than a form.** An enquiry is a record, not an email, because an email
is somebody's inbox: `org.enquiry` (migration 0036), a public `POST /api/enquiries` on the staff
platform, and an Enquiries screen high in the staff navigation. `SERVICE_OPTIONS` is the dropdown, as
it was always meant to be.

The endpoint is the only route in the platform a stranger may write through, so: every field
trimmed, length-capped and validated in the core *and* by CHECK constraints; a per-address rate limit
counted in the database rather than in memory, checked before anything else so a flood costs nothing
and a visitor's typos cannot lock them out; the body capped before it reaches the parser; a honeypot
field that answers "received" rather than telling a script which check caught it; CORS restricted to
listed origins with no wildcard; and no error that tells a stranger anything about the inside. A
trigger refuses any edit to what an enquirer wrote — the firm's handling is recorded beside it, so
"answered" cannot be achieved by rewriting the question.

The form says what actually happens: the enquiry reaches a screen the firm reads, with a reference,
and no turnaround is promised because there is no mail transport and nobody has promised one. If the
endpoint is unreachable it says so and puts the telephone number in front of the visitor — a form
that swallows an enquiry is worse than no form, because the visitor believes they have been in
touch.

### 12.2 A soft 404 on every unknown URL

`apps/web/src/App.tsx:59` — `<Route path="*" element={<Home />} />`, and `vercel.json` rewrites
everything to `index.html`. So any nonexistent URL returns **HTTP 200 with homepage content** and a
canonical pointing at the site root. Search engines will index arbitrary URLs as the homepage. There
is no 404 page. The "Discipline not found" panel for a bad service id renders no `<Seo>` either, so
the tab keeps whatever title the previous route left.

**Fixed.** A real not-found page, with the address that was asked for, the navigation and the six
disciplines. A static host cannot return a 404 status for a rewritten path, so the page carries
`noindex, follow` and a canonical of its own path instead — and `Seo` removes the robots tag again on
the way out, so navigating from it to a real page does not mark the real page noindex. The
"Discipline not found" panel gained the same treatment. Verified in the browser: one `<h1>`,
`noindex, follow`, and a canonical of the requested path.

### 12.3 Accessibility barriers that stop people

> **All four fixed**, and each verified in the browser rather than by reading the diff.

- **The mobile drawer and the "Book Consultation" dropdown stay in the tab order while closed**
  (`Navbar.tsx:143`, `:101`) — hidden with `max-h-0 opacity-0` and `pointer-events-none`, neither of
  which removes focus. A keyboard or screen-reader user tabbing past the brand lands on seven
  invisible links, on every page. Neither control has `aria-expanded` or `aria-controls`, and the
  panels have no `aria-hidden`, so a screen reader is never told the menu opened. **Fixed** with
  `inert` on both panels while closed — which removes the subtree from focus *and* from the
  accessibility tree, where `aria-hidden` alone would leave it tabbable — plus `aria-expanded` and
  `aria-controls` on both controls. Verified: nine invisible links out of the tab order, and the
  dropdown becomes reachable the moment it opens.
- **The address dialog is not a dialog** (`AddressModal.tsx:31`): no `role`, no `aria-modal`, no
  accessible name, and focus is never moved into it or trapped. Escape closes it, but Tab walks the
  page underneath an opaque overlay. **Fixed:** `role="dialog"`, `aria-modal`, a name from its own
  heading, focus moved in on open, Tab wrapped at both ends, and focus returned to whatever opened
  it. Verified in the browser, including the return.
- **The splash screen runs ~5.2 seconds on every page load**, full-screen at `z-[100]`, with no skip
  and no click or key dismissal (`SplashScreen.tsx:163`). Reduced motion shortens it to ~1.6 s, which
  is the right instinct; nobody else can get past it. It also emits a second `<h1>` that coexists
  with each page's real one. **Fixed:** a click, a tap or any key ends it — no button to find, which
  is the point — and the overlay is `aria-hidden` with the wordmark demoted from `<h1>`, so a screen
  reader reads the page rather than the animation. Verified: Escape clears it within a second.
- **The four footer social links contain only an icon** with `aria-hidden="true"` and no label, so a
  screen reader announces four unnamed links on every page. The services search input has no label
  either, and its clear button has no accessible name. **Fixed:** each social link names itself, the
  search has a visually-hidden label and the clear button an `aria-label`. The LinkedIn link is gone
  rather than named — see below.

### 12.4 Content

- ~~**The LinkedIn button is `href="#"`**~~ with `target="_blank"` — it opens a second tab of the
  current page. Visible site-wide. **Removed** rather than named: a link to nowhere is not improved
  by labelling it. When CAC has a page, its URL goes in `data.ts` beside the TikTok one.
- ~~**The search hint suggests a term that matches nothing.**~~ **Fixed:** "ownership", which
  matches, in place of "ROI", which does not. Suggesting a term that returns nothing, on the screen
  that has just returned nothing, is the opposite of help.
- ~~**Mr Shiva's role contradicts his own blurb**~~ — `data.ts:52` says "Managing Director", the blurb
  two lines later says "as a Senior Consultant". Both show on the same card. **Fixed by removing the
  second title, not by choosing between them**: which is right is CAC's to say, and the sentence
  reads the same without it. Worth CAC confirming.
- ~~**A CTA paragraph is parked in the wrong section**~~ (`WhyCAC.tsx:106`) with no link attached.
  **Fixed:** it now has the button it was inviting people to press, pointing at the enquiry form.
- ~~**`group-hover: glow-gold`**~~ (`Navbar.tsx:51`) — a stray space breaks the variant, so the brand
  halo is always on. **Fixed.** The space made it two classes: a bare `group-hover:` that does
  nothing and an unconditional `glow-gold`.
- ~~**Per-consultant contact details are declared and never built**~~ — `TeamMember` has optional
  phone and email fields with a documented fallback; `Contact.tsx` renders neither. **Fixed:**
  rendered when present, absent otherwise, which is the documented fallback. No values are seeded, so
  nothing changes on screen until CAC adds one.
- **Four unused assets**, including `property.lottie` — an animation that was cut. **Left alone**:
  deleting a file that something loads dynamically is a worse outcome than a few unreferenced
  kilobytes, and a sweep cannot prove nothing loads them.
- **`sitemap.xml` has a hand-written `lastmod` of 2026-08-20** and is not regenerated by the build.
  **Left alone**: a `lastmod` that is always today is as untrue as one that is always August, and
  what it should say is when CAC last changed the page — which the build does not know.

Verified good: all 26 asset paths resolve, all routes and internal links resolve, every icon name
exists, WhatsApp/tel/mailto links are well-formed, the build is clean with zero warnings, all 12
routes prerender with unique complete metadata, and the six services and seven process stages are
internally consistent everywhere they appear.

---

## 13. What remains unaudited

**Estate cases and the case agent (Phases 9 and 11).** The auditor for this slice was cut by the
usage limit twice before producing anything. Not audited: the three-valued rule engine's edge cases,
the recomputation invariants, whether every read of `estate.case` and its children is scoped by
`caseAccessClause`, and the preparation-pack PDF's layout limits.

What is known about it: 79 tests cover the rule engine's three-valued logic, the recomputation
invariants and the access scoping, and all pass. The browser pass rendered every case screen
cleanly. That is not the same as an adversarial read, and the accounting and auth slices are the
proof — both were fully tested and both had defects that only a read found.

## 14. Honest summary of severity

The platform's **deliberate refusals all hold**: nothing fabricates a statutory rate, a legal
requirement, a malware verdict or an embedding. Those were the hard parts and they are sound.

What the audit found instead is a consistent pattern: **the gaps are between correct pieces.** A cap
enforced in one function and not on the path that edits the same row. A maker/checker pair declared
in one file and not honoured in another. A capability granted to the one role that needs it, on a
route gated by a different one. Attendance finalised for a payroll that never reads it. Four fields
read from today's row in a module built to be reproducible.

Every one of those is invisible to a unit test of either piece, and every one of them is the kind of
defect that reaches production in a system this size.
