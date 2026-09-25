# CAC — Implementation Plan

Phases are sequenced by **dependency**, not by visible progress. Each ends with tests
passing, docs updated and a coherent commit. No phase is "done" because a page exists —
see Definition of Done below.

---

## Phase 0 — Inspection and architecture ✅ *complete*

Baseline recorded, seven documents written, blocking questions raised.

**Baseline:** commit `e03ec11` · build exit 0 · 12 routes prerendered ·
JS 338 kB (102 kB gz) · **`tsc --noEmit` fails with 4 `TS6133` errors** · **no tests** ·
**no CI** · no backend, no database, no auth, no data flow anywhere in the site.

---

## Phase 1 — Foundation and security ✅ *complete*

Groundwork with no business features. Nothing here is user-visible except a login page.

1. **Monorepo.** pnpm workspaces; move the site to `apps/web` unchanged; verify the build
   output is byte-identical; repoint the Vercel root directory.
2. **CI gate.** Typecheck, lint, test, build on every push. Fix the 4 existing `TS6133`
   errors so the gate is green from day one.
3. **`apps/staff` scaffold** — Next.js, shared brand tokens, enterprise shell (sidebar,
   header, breadcrumbs, role-aware nav).
4. **Database** — Postgres provisioned, Drizzle, migration pipeline, `auth` schema.
5. **Auth** — argon2id, DB sessions, TOTP MFA, throttling, lockout, password reset,
   device list, logout-everywhere.
6. **RBAC** — capabilities, roles, `requireCapability` / `requireScope` helpers, seeded
   from `RBAC_MATRIX.md`.
7. **Audit** — append-only `audit.event`, written in-transaction, redaction layer.
8. **Admin** — user management, role assignment, settings with audit.
9. **Public site gesture** — HOME double-click → staff login. One component, one file.

**Exit:** a user can log in with MFA, see a role-aware empty dashboard, and every action
is audited. Permission tests prove server-side denial with the UI bypassed. ✅

**Delivered:** commits `e4596a4`, `3b535fd`, `c07de01`, plus the administration and
self-service work that closed the gaps Phase 2 exposed — account creation with a one-time
password, role assignment with a no-self-escalation rule, suspension, password and
authenticator reset, TOTP enrolment with QR and recovery codes, a forced change of an
administrator-issued password, and an editable settings screen.

**Still open from this phase:** the public-site HOME double-click gesture (item 9), which
is a change to `apps/web` and is being held until the staff app has a stable URL. Item 4
reads "Postgres provisioned"; it is PGlite against a local file until Q-INFRA-1 is
answered, with the same dialect and one connection string between the two.

---

## Phase 2 — Accounting foundation ✅ *complete*

Chart of accounts · fiscal years · periods · **journals and the posting engine** ·
customers · suppliers · document sequences.

**Exit:** a manual journal can be drafted, balanced, posted and reversed; an unbalanced
journal cannot post; a closed period rejects posting; the trial balance totals to zero.
All proven by tests before any invoice UI exists. ✅

> The posting engine is the spine. Everything financial posts through it. Built and
> tested first, deliberately.

**Delivered**

| Piece | Where |
| --- | --- |
| Money as integer ten-thousandths, never float | `packages/core/src/money.ts` |
| Calendar dates, UTC, no timestamps for periods | `packages/core/src/dates.ts` |
| Chart of accounts — 119 accounts, contra support, system accounts | `packages/db/src/coa.ts` |
| Fiscal years and periods, gapless, non-overlapping | `packages/core/src/periods.ts` |
| **The posting engine** | `packages/core/src/posting.ts` |
| Trial balance and account ledger | `packages/core/src/ledger.ts` |
| Gapless document numbering | `packages/core/src/sequence.ts` |
| Customers and suppliers | `packages/core/src/parties.ts` |
| Schema and database guards | `migrations/0002_accounting.sql`, `0003_accounting_guards.sql` |
| Screens | `apps/staff/src/app/accounting/**` |

**Proof.** 152 tests, of which 67 cover the ledger, run against real PostgreSQL through
real migrations — so the CHECK constraints and triggers are exercised, not mocked. Each
exit criterion has a test named after it. Verified again by hand end to end: two
accountants, one prepares `JV-2026-00001`, cannot post their own, the second posts it, a
director-grade reversal produces `JV-2026-00002`, and the trial balance reads nil.

**Not in this phase, deliberately:** no tax rate is seeded. `tax_code` rows exist,
`tax_rate` is empty, and `tax_rate.source_ref` is `NOT NULL`, so no rate can enter the
system without a citation. See Q-FIN-1.

---

## Phase 3 — Accounting operations *(invoicing needs Q-FIN-1)*

Quotation → Invoice → Receipt → allocation · Payment voucher · Petty cash · Purchase
order · Claims · SST configuration · AR aging · Trial Balance, P&L, Balance Sheet with
drill-down · PDF/Excel export.

**Exit:** the full Definition of Done example below passes end to end.

**Delivered in two parts.** 3a is the money coming in: quotation, invoice, credit note,
receipt, allocation, the SST configuration screen, AR aging with a reconciliation line
against account 1210, and the three statements with drill-down. Real PDF invoices and
RFC 4180 CSV export. The worked example passes end to end, and 51 tests follow exactly
that sequence.

3b is the money going out: purchase orders, payment vouchers (buying something, paying on
account, settling a supplier account), the petty cash float with a physical count, and
expense claims. 39 tests. A purchase order deliberately reaches no ledger account — a
commitment is not a cost — and the cost appears when a voucher is raised against what
actually arrived. A petty cash count that disagrees posts the difference as an attributed
expense rather than adjusting the balance to fit.

**Still open.** Approval thresholds for documents depend on Q-FIN-3, and who may post a
manual journal on Q-FIN-5. Until each is answered the conservative reading applies and the
screen says which question it is waiting on.

---

## Phase 4 — Compliance and integration *(needs Q-FIN-2)*

Bank/cash reconciliation with CSV import · `EInvoiceProvider` abstraction +
`MyInvoisProvider` against **sandbox** · additional statutory reporting.

**Exit:** reconciliation works on real statements; the e-Invoice adapter passes against
sandbox and is **clearly marked awaiting production credentials**. Nothing fake is
presented as working.

**Bank reconciliation is delivered.** Statement import from whatever CSV the bank
exports — delimiter detected, RFC 4180 quoting, a byte order mark stripped, preamble rows
skipped, and the column mapping guessed but always shown before it is used. Matching a
statement line to a ledger line is a judgement and is audited as one, individually.
Candidates are offered and never applied automatically; a wrong automatic match is worse
than none, because nobody looks at it again. 50 tests.

Two refusals carry most of the value. An import whose rows do not account for the movement
between the stated opening and closing balances is refused, which catches a truncated or
filtered download on the day rather than six weeks later. And the same file cannot be
imported twice, which is the commonest import error and duplicates every transaction on it.
Both can be overridden, and both record that they were, against a name.

Signing off needs two conditions, because either alone proves nothing. The **difference**
is arithmetic on where the two records start from — it catches a ledger whose opening
balance was never right, or a statement imported over a gap. The **unmatched line count**
is the human part: every line the bank reported has to have been matched, posted, or set
aside with a reason. A completed reconciliation is then immutable, by trigger: a journal
back-dated into a reconciled period cannot rewrite what was signed.

**e-Invoicing is a boundary, not an integration, and says so.** `EInvoiceProvider` is the
interface; `NotConfiguredProvider` is what is installed, and it *raises* rather than
returning a failure that could be mistaken for a rejection by LHDN. The MyInvois adapter is
written against the published API but has never been exercised, because no sandbox account
exists — so the screen says exactly that. **There is deliberately no mock that reports
success**: an invoice that looks validated when it was never sent is worse than one that
plainly was not.

What the screen does offer is the work that can start today and takes longer than the
integration: CAC's own TIN, a TIN for every customer already invoiced, and a classification
code per service. The adapter refuses to send a line without a code rather than guessing
one, because a wrong code is a rejection whose cause is buried in LHDN's response.

**Not in this phase.** Statutory reporting beyond the three statements, which needs Q-FIN-1
answered before an SST return means anything.

---

## Phase 5 — HR foundation *(needs Q-HR-2 sample file)*

Employees, departments, positions, work schedules · **thumbprint Excel import** with
staging, column mapping, validation, preview, error report and explicit confirmation.

**Exit:** a real export from CAC's device imports, with bad rows rejected and reported,
and nothing reaching final attendance without HR confirmation.

**Delivered, with the sample still outstanding.** Departments, positions, work schedules,
public holidays, employees, append-only employment history, and the staged attendance
importer. 60 tests; 362 across the suite.

The importer is deliberately **not** written against a particular device, because Q-HR-2's
sample has not arrived. It reads any delimited export, handles both shapes real readers
produce — one row per scan, or one row per day — and the column mapping is guessed, shown,
and only then used. Scans are grouped per person per day: earliest is the arrival, latest
the departure, so lunch is not a second working day, and two scans seconds apart are one
event rather than a two-minute day. A date that could be read either way is refused instead
of guessed. When a real export arrives, the mapping is remembered against the device.

**Identity comes from the device number, never the name.** Two people called Tan is a real
situation, and the importer sets such rows aside rather than putting one person's attendance
on the other's record. Employees with no mapped number are listed on three screens, because
otherwise their attendance simply never appears.

**Three things enforced in the database rather than trusted.** Employment history refuses
UPDATE and DELETE outright — the salary in force on a past date is what makes a payroll
rerun reproducible, and Phase 7 cannot be built without it. Finalised attendance cannot be
edited, and nothing new can be inserted into a finalised period. Confirming an import never
overwrites a day already recorded, so a correction made by hand survives a re-import.

**Personal data.** The identity card number and bank account number are encrypted at rest
with the key outside the database; the last four digits live in their own column so lists
and search never decrypt anything. `Employee` and `EmployeeSensitive` are separate types, so
a screen cannot render what it did not ask for — the mistake is a compile error rather than
a disclosure. Reading the sensitive fields needs a capability *and* a stated reason, and
writes an audit row.

**Not seeded, deliberately:** no public holidays. Malaysian holidays are partly federal and
partly by state, several move with the lunar calendar, and which states CAC's staff work in
has not been stated. A wrong holiday makes a present employee absent and an absent one
present. Each holiday requires the gazette or circular it came from.

---

## Phase 6 — HR workflows

Attendance calculation engine (late, early-out, extra time, missing clock, overnight
shifts, public holidays, leave overlap) · overtime requests · leave · time-off and
early-clock-out · claims · appraisals.

> **Extra time ≠ payable overtime.** Extra time is calculated; payable OT is a separate
> decision gated on eligibility, company rule, statute and approval.

**Delivered.** The attendance calculation engine, leave, overtime, short absences and
appraisals. 62 tests; 424 across the suite.

**The engine is a pure function.** `computeDay` takes the schedule, the holidays, the
approved leave and the approved absences as arguments and reads no database, so the awkward
cases are testable directly: a night shift whose clock-out is on the next date, a public
holiday somebody worked anyway, a day covered by half a day's leave, a missing clock-out.
`recalculateAttendance` fetches everything once and hands it over.

Three of its rules are worth stating:

- **Extra time is never payable.** `extraMinutes` is what the clock says;
  `approvedOtMinutes` is copied from an approved overtime request and from nowhere else. A
  test proves 150 minutes on the clock against 120 approved, which is the whole point.
- **An authorised absence is not lateness.** Approved time off reduces what was expected of
  the day rather than counting against the person. Without that distinction, permission to
  attend a hospital appointment looks exactly like turning up two hours late — and the test
  suite proves the same clock times produce lateness for somebody without permission and
  none for somebody with it.
- **Half the evidence produces no figure.** A clock-in with no clock-out is reported, not
  guessed at. Guessing would invent a number that becomes a payslip.

**What the engine never touches:** a finalised day. Payroll may already have read it, and
recomputing it would change a payslip's basis after the fact; those are counted and reported
instead.

**Leave** counts days against the working week and the holiday calendar, not against dates
— Friday to Monday is two days, and a public holiday inside the span is not leave. The
figure is stored on the request, so a later change to the schedule cannot silently restate
how much leave somebody took. Balances are derived from approved requests by trigger: a
balance that disagrees with the requests beneath it is worse than none, because somebody
reads it and approves leave that is not there. Approving beyond the remaining balance is
possible but deliberate, and recorded as an exception.

**Nobody approves their own anything** — leave, overtime or time off — and that is enforced
on the person rather than the role, so holding a senior capability does not help.

**An acknowledged appraisal never changes.** Acknowledging is not agreeing: the employee's
comment field exists so somebody can accept that they have read a review while recording
that they disagree with it, which is the distinction that matters if it is ever produced in
a dispute.

**Not authored here.** Leave entitlements (Q-HR-3, new) and overtime rate multiples
(Q-HR-1). Both are legal schedules; both are nullable, both require a source before a figure
may be used, and nothing is seeded. An overtime claim can be approved with the hours agreed
and no rate, which is the honest state while Q-HR-1 is open: payroll then refuses to pay it.

---

## Phase 7 — Payroll *(needs Q-HR-1 — will not proceed without official schedules)*

Payroll run lifecycle · EPF/SOCSO/EIS/PCB via **versioned, effective-dated**
`statutory_rule_version` · payslip PDF · posting to the ledger.

**Exit:** payroll is reproducible — rerunning a past period with its recorded rule version
produces identical output after rules change. Payslips are private to the employee.

**Delivered, and it stops at the boundary.** The run lifecycle, the effective-dated rule
versions, the payslip PDF and the ledger posting are all built and tested. 30 tests; 454
across the suite. **No statutory rule is seeded, and payroll refuses to run without them.**

The exit criterion is proven directly. A test changes the EPF rate from April and gives
somebody a raise from April, then re-runs March: March's salary, March's rate, March's
figures. Three things make that work — the salary is read from dated employment history
rather than the employee row; the rules come from the version whose effective dates cover
the pay date; and each payslip line records the rule *version* that produced it. An approved
rule version is immutable by trigger, so none of it can drift.

**Why the rules are data.** EPF is not a percentage — it varies by age and wage band. SOCSO
and EIS are contribution *tables*: the amount is read from the band, not the band multiplied
by anything. PCB is a schedule with reliefs. Writing `wages * 0.11` anywhere would be the
platform asserting Malaysian law it has not been told. So each is a band table entered with
the document it was copied from, approved by somebody other than whoever typed it, and fixed
from then on. `StatutoryRulesMissingError` names exactly which are absent, and the payroll
screen says so in plain words rather than failing obscurely.

**The lifecycle is four people's work.** Computed, approved by somebody else, finalised
(payslips become documents; the overtime paid is marked paid so it cannot be claimed twice),
posted. A run with any payslip that could not be computed cannot be approved at all — a run
that quietly paid twenty-nine of thirty people is the worst available outcome.

**The posting.** Debit the costs — salaries, overtime, allowances, and the employer's own
contributions — credit what is owed to each agency, and credit net pay to *salaries
payable* rather than to the bank. Paying the staff is a separate voucher against that
account, so the ledger shows the obligation between the two. Reversing the journal returns
the run to finalised without disturbing the payslips: the accounting was wrong, the payroll
was not.

**Two bugs the tests found.** PCB was being credited to the employer's side of the payslip
rather than deducted from the employee — it silently moved money across the payslip without
changing any total. And the employer's contributions were debited as an expense with nothing
credited as a liability, which the balanced-journal assertion caught: the ledger knew the
cost and not the obligation. Employer lines now carry a contra account and post both sides.

**The payslip** prints how every figure was arrived at and, for each statutory deduction, the
document its rate came from. The employer's contributions are shown separately and marked as
not part of net pay. A payslip from a run that is not yet finalised says DRAFT on the page and
on the PDF. Payslips are scoped by the session in the data layer, so changing the id in the
URL does not work — including on the PDF route.

---

## Phase 8 — HR documents

Template-driven appointment and confirmation letters, DOCX + PDF, versioned, approved,
immutable once issued.

**Exit:** a letter reproduces byte-identically from its own record, and revising the template
it came from does not change it.

**Delivered.** Templates, letters, both file formats, and the approval path. 33 tests; 487
across the suite.

**The letter is the record, not the template.** When a letter is generated, the template body
of that moment, the variables it declared, the values typed in, and the rendered text are all
copied onto the letter. Nothing re-renders afterwards — the screen, the PDF and the Word file
all print the stored text, so the three cannot disagree, and a template revised next year
leaves last year's letters alone. The final test in `letters.test.ts` proves exactly that:
approve a v2 with different wording, then re-read the letter issued from v1.

**Templates are versioned, not edited.** Code plus version is unique, one version per code may
be approved at a time, and approving a new one retires its predecessor. Whoever wrote a
version cannot approve it, and a draft cannot be used to write to anybody. A letter records
`code` and `version`, so "which form of words was this person sent" has a fixed answer.

**The template language is deliberately small.** Placeholders and `{{#if}}…{{else}}…{{/if}}`.
No loops, no arithmetic, no expressions — a letter about somebody's employment is not a place
for a computed clause nobody reviewed. A placeholder that was never declared is refused when
the template is saved, including inside a branch that happens not to be taken, because the
untaken branch is the one that surprises somebody later. A required variable left blank is
refused at generation.

**Issued means issued.** A trigger makes issued letters immutable — body, values, dates, all
of it. A wrong letter is corrected by generating one that supersedes it; both stay on the
record, which is what somebody holding a copy of the first deserves. The supersede chain is
cycle-guarded in the database. Appointment letters are allowed to predate the joining date,
because that is when appointment letters are written.

**Word as well as PDF**, because these get signed, annotated and filed; without an editable
form somebody retypes the letter, and a retyped letter differs from what the system says was
sent. Both formats carry the template version as provenance and a DRAFT line until issued.

**Not authored here.** No letter wording is seeded. Templates are CAC's own text, entered with
the source reference for where the wording came from (Q-DOC-1).

---

## Phase 9 — Case management *(needs Q-LEGAL-1)*

Probate and LA case records · parties, assets, liabilities · tasks · timeline ·
**dynamic checklists** (scenario-driven, never a fixed list per case type) · documents.

**Exit:** two matters with different facts get different checklists from the same rules,
and a short checklist never means "nobody asked".

**Delivered, and it stops at the boundary.** The case record, the inventory, the
parties, the document register, tasks, the timeline and the checklist engine are all
built and tested. 79 tests; 566 across the suite. **No Malaysian probate rule is seeded,
and a matter's checklist is empty until CAC's named reviewer enters and approves them.**

**Facts are recorded; requirements are derived.** This is the whole design. A case holds
facts about the estate — was there a will, is a beneficiary a minor, what does the estate
consist of. What each fact *requires* is not in the schema and not in the code: it lives
in `estate.requirement_rule` as data, entered with the authority it came from and
approved by somebody other than its author holding `case.rule.approve`. A checklist is
then computed from one matter's facts against the rules in force. The first test in
`cases.test.ts` proves the shipped state: a case, no rules, an empty checklist, and a
reason for it (Q-LEGAL-1, Q-LEGAL-2).

**The engine is three-valued, and that is the most important decision in the phase.** A
condition over a question nobody has answered evaluates to *undecided*, not false. Two
valued logic would quietly drop a requirement because a question had not been asked
yet — and a checklist that is short because of missing information looks exactly like a
checklist that is short because nothing is required. An undecided rule keeps its item on
the list, flagged with the questions it needs, and the intake screen is where somebody
clears it. "Not known" is itself a recordable answer, distinct from an empty one.

A definite false still settles an `all`, and a definite true still settles an `any`, so a
single missing answer does not make every rule undecided. `not` over undecided stays
undecided: negating "we do not know" does not produce knowledge.

**The condition language is deliberately small.** Boolean combinations of comparisons
against declared facts — no arithmetic, no expressions, no dates computed from other
dates. Anything more expressive becomes a language in which somebody can write a legal
rule nobody reviewed. Facts are *declared* before rules can reference them (a rule
waiting on a fact nobody records never resolves), a question's type is fixed once answers
exist, and a condition naming an undeclared question is refused when the rule is saved
rather than puzzling somebody later.

**Recomputation never deletes.** An item that stops applying becomes `not_applicable`
with the reason it fell away, because "this used to be on the list" is a question that
gets asked. An item already satisfied or waived is left entirely alone — a change of
facts does not erase work. An item from a rule that has been withdrawn says so, and
keeps the code, version, title and authority it carried when it was on the list, exactly
as a letter keeps its template.

**A figure cannot exist without its basis and its source**, by CHECK in both directions:
a basis recorded against a figure that does not exist is also refused, because it means
somebody stopped halfway. The estate position sums what it has, counts what it does not,
and says in words when a total is not the estate's total.

**Reported is not verified.** `case.fact.verify` is a separate capability from
`case.edit`; the database stamps who attested and when, and un-verifying clears the
stamp rather than leaving a stale name against a claim somebody no longer makes.

**Access is a join, not a filter.** `case.view` means the matters somebody is assigned
to and `case.view_all` means all of them; every read goes through `caseAccessClause`, so
changing an id in a URL gets a 404 rather than another family's file. A matter cannot be
left with nobody assigned to it. The timeline is append-only by trigger, a closed file
refuses writes at the database rather than only in the application, and closing is
refused while any requirement is outstanding or any task is open — withdrawing is the
honest route for a matter that stopped.

**Audit rows here do not carry the contents of the file.** A party's row says a
beneficiary was recorded; it does not say who, or what they are said to be entitled to.
Reading a full identification number is a separate capability-gated call that writes
`EXPORT_SENSITIVE` with a reason, as it is for an employee's NRIC. A test asserts that no
beneficiary name or stated share reaches the audit trail.

**One bug the code review found, in the RBAC bundles rather than this phase.**
`CASE_MANAGER` was built with `has("case.")`, which handed it `case.rule.approve` and
`case.document.approve` — the two approvals `docs/RBAC_MATRIX.md` says sit only with the
authorised reviewer and the director. The code and the documented matrix disagreed, and
the code was wrong. Narrowed, with `case.rule.propose` / `case.rule.approve` added to the
maker/checker pairs.

**Not authored here.** Every requirement rule, every intake question and every authority
behind them. The document *register* is built; the files themselves are Phase 10, and
`storage_key` is where ingestion attaches — an upload button with nowhere to put the bytes
and no scanning would not be honest.

---

## Phase 10 — Knowledge ingestion *(needs Q-AI-1, Q-DATA-2)*

Upload → malware scan → checksum → classify → OCR where needed → extract → chunk →
embed → index. Provenance on every chunk (document, page, method, confidence). Originals
retained immutably. Hybrid retrieval, permission-filtered in SQL.

**Exit:** a document's route through the pipeline is visible and explains itself, every
retrieved passage says where it came from and how the text was obtained, and nothing
claims to have done a step it did not do.

**Delivered, and three of its dependencies are absent by design.** The pipeline, the
immutable originals, the chunking, the provenance and full-text retrieval are built and
tested. 61 tests; 627 across the suite.

**Nothing says a file is clean unless a scanner said so.** An uploaded file is
checksummed from the bytes received and stored in quarantine, where it cannot be
downloaded, read, extracted or indexed — enforced by trigger as well as in the pipeline.
`ClamAvScanner` is real and speaks clamd's INSTREAM protocol; `NotConfiguredScanner` is
what is installed, and it refuses. A scanner that cannot answer produces `scan_failed`,
which is not clean. An infected verdict is final: the database refuses to move that row
to any other status, and no capability releases it.

The escape hatch for a firm with no scanner is a deliberate *release*, which takes
`doc.archive`, takes a reason of at least a sentence, is audited, and marks the document
`released_unscanned` permanently. Nothing afterwards ever calls it clean, search excludes
it unless asked, and the screens say so. **There is no stub that reports clean**, for the
same reason there is no e-Invoice mock that reports validated.

**Extraction either reads the file or declines.** Plain text, CSV, Markdown, JSON, XML and
HTML are read directly; DOCX is read from its own `<w:t>` text runs, which is exact rather
than heuristic. **PDF is refused.** Parsing a PDF text layer correctly means resolving
font encodings including CID fonts, and done imperfectly it produces text that is
*plausible and wrong* — transposed characters, lost diacritics — on a document that may be
produced in evidence. Many of these files are scans with no text layer at all. So a PDF or
an image is `needs_ocr`, the reason is on the document, and `NotConfiguredOcrEngine`
refuses rather than returning a blank page that would be indexed as a blank document.

**Provenance on every passage.** A chunk carries its document, page range, character span
into the extracted text, the method that produced the text and that method's confidence.
A chunk spanning a certain page and an OCR'd one takes the *weaker* claim, because a
passage is only as reliable as its least reliable part. Chunk text and provenance are
immutable by trigger: rechunking deletes and rewrites, which is visible.

**Search works, and says what it is.** Two generated tsvectors per chunk — `english`,
which stems, and `simple`, which does not. PostgreSQL ships no Malay configuration, so
Malay is matched on exact tokens by the `simple` vector while English also benefits from
stemming; a query runs against both, and a test proves a Malay phrase is found. Results
are permission-filtered *in the query*: a case document is invisible to somebody not
assigned to that matter, including through search. Every result reports `strategy:
"lexical"` and a note saying semantic search is unavailable, because a search that implied
otherwise would make an empty result look like an answer.

Alongside the hits, search returns the documents whose text **nobody can search**, with
the reason for each. "Not found" and "never read" are different answers, and a library
that conflates them loses documents quietly.

**Embeddings are wired and absent.** `NotConfiguredEmbeddingProvider` refuses, and the
document records `not_configured` rather than `failed` — nothing is broken, something is
absent. A fabricated vector would produce a search that returns ranked, plausible,
unrelated results, which is worse than one that returns nothing.

**Two bugs and one real gap the work found.** The trigger that keeps a chunk's evidence on
the same case as the chunk was written as one function parameterised by `TG_ARGV`;
plpgsql plans the whole expression, so it failed at runtime on whichever table lacked the
other column. Split in two. The ingestion log's no-delete trigger blocked the cascade when
a document is destroyed — the log describes a document and does not outlive it, so DELETE
is allowed and `audit.event` is the record that survives. And **`doc.archive` and
`doc.delete` were capabilities held by no role at all**: nobody could archive a document
or destroy an original. `doc.archive` now sits with `CASE_MANAGER` and `DIRECTOR`,
`doc.delete` with `DIRECTOR` alone, and `docs/RBAC_MATRIX.md` says why.

**Not authored here.** The scanner, the OCR engine and the embedding model. Each is a
configured dependency with a refusing default, and choosing the last two is not only
technical: these documents hold identifiable people's data, and whether it may be sent to
a third party or leave the country is Q-AI-1 and Q-DATA-2.

---

## Phase 11 — AI case agent *(needs Q-LEGAL-2)*

Guided intake · **deterministic rule engine** + AI assistance · missing-information
detection · evidence and document checklists · conflict detection · precedent retrieval ·
the case preparation pack.

> The rule engine decides requirements. The model assists, cites and drafts. It never
> determines a legal requirement alone, and never submits anything.

---

## Phase 12 — Document automation

Template engine with conditional clauses and validated variables · DOCX first, PDF on
finalisation · full provenance (template version, case version, model version, reviewer,
approval).

---

## Phase 13 — Hardening

Penetration-style permission testing · performance · backup and **tested restore** ·
monitoring · UAT · production cutover. `docs/BACKUP_AND_RECOVERY.md` is written here and
the restore is actually performed, not just documented.

---

## Sequencing notes

- **Phases 1–4** (accounting) and **5–8** (HR) are independent after Phase 1. If CAC has
  no in-house payroll (Q-ORG-1), 5–8 may be dropped or deferred — a large saving.
- **Phases 9–12** depend on legal sign-off, not on engineering. They can start at Phase 9
  while accounting proceeds, provided Q-LEGAL-1 is answered.
- Blocked work is built **up to the boundary** and stops there, visibly. Gaps are never
  filled with a guess.

## Risks

| Risk | Mitigation |
|---|---|
| Legal rules encoded wrongly | Rule engine is effective-dated, source-linked, human-approved; agent output is never final |
| Statutory payroll tables wrong | Versioned rules, official sources only, payroll blocked until Q-HR-1 |
| Scope is very large for one consultancy | Strict phasing; each phase independently useful; 5–8 droppable |
| Hobby plan / infra | Q-INFRA-1 raised as blocking before any build |
| Public site regression | Separate app, separate deploy, CI gate, unchanged except one gesture |
| PDPA exposure | Masking, RBAC, audit, retention, no real data outside production |

---

## Definition of Done

A feature is complete when **all** of these are true — not when the page renders:

UI · responsive · database schema + migration · Zod validation · capability **and** scope
checks · business rules server-side · audit trail · error/empty/loading states · tests
(unit, integration, permission) · documentation · exports/documents where applicable ·
integration with related modules.

**Worked example — "Invoice module complete":**

create a customer → create an invoice → add lines → totals computed **server-side** →
configured tax applied → save draft → submit → approve **as a different user**
(maker/checker) → issue → PDF generated → journal posted and balanced → receipt recorded →
partial settlement → full settlement → appears correctly in AR aging → ledger entries
visible → reflected in trial balance, P&L and balance sheet → complete audit history →
and a user without `invoice.approve` is refused **by the server** when the UI is bypassed.

Anything less is not done.
