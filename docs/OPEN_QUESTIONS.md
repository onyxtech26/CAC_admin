# CAC — Open Questions

Categorised as the brief requires. **BLOCKING** stops a specific phase. **CONFIGURABLE**
is built as a setting with a documented default and does not stop anything.

---

## BLOCKING

### Q-INFRA-1 — Hosting plan, database and data residency *(blocks Phase 1)*

The Vercel team `Onyxx Tech Hub` is on the **Hobby** plan. This is already causing real
failures: three production deploys were rejected with state `BLOCKED` after the repo went
private, because Hobby does not support collaboration on private repositories.

Hobby is not viable for this platform:
- Commercial use is outside the Hobby terms.
- No team seats, so every staff member would share credentials.
- No SLA, and no support path when an ERP is down.

A Pro (or higher) plan is needed, **or** a different host. Equally important: where does
the **database** live, and in which region? PDPA makes residency a real decision, not a
default.

> **Needed:** confirmed hosting plan, database provider, and the region personal data may
> be stored in.

**Sharper after Phase 2.** The interim local database is PGlite — real PostgreSQL compiled
to WebAssembly, persisted to a file. Same dialect, same migrations, same constraints, one
connection string away from a hosted server; it was the right way to get the ledger built
without waiting for this answer.

It is also an *embedded* database, so exactly one process may own its data directory.
Concretely: a command-line task cannot run while the application is running, and the
application itself has to be careful to hold a single instance
(`packages/db/src/client.ts` explains how, and `lock.ts` recovers the directory after an
unclean shutdown). Those are workarounds for something a hosted PostgreSQL does not have.
Before real users and real data, this needs a server.

### Q-SEC-1 — PDPA data residency and retention *(blocks Phase 1 schema)*

Must personal data remain in Malaysia, or is a Singapore region acceptable? Retention
periods are needed per category: employee records after termination, case files after
completion, accounting records, audit logs, CCTV-adjacent attendance data.

> **Needed:** residency constraint, and a retention period per data category.

### Q-LEGAL-1 — Who approves legal content *(blocks Phases 9–12)*

`case.document.approve` and `case.rule.approve` must sit with a named, qualified person.
CAC is a forensic consultancy, not a law firm — the public site is careful to say reports
"may assist legal advisers… subject to the applicable rules of evidence".

The Probate/LA rule engine encodes legal requirements. **I will not author Malaysian legal
rules from general knowledge, and I will not treat internet articles as law.** Rules must
come from authoritative sources and be approved by someone qualified to do so.

> **Needed:** the named reviewer, their qualification, and confirmation that CAC may
> prepare these documents in the capacity envisaged.

### Q-LEGAL-2 — Authoritative sources for Probate/LA *(blocks Phase 11)*

The rule engine needs primary materials: the governing legislation, the applicable court
rules and official forms, and the small-estate route and its thresholds.

> **Needed:** either CAC supplies its current authoritative set, or explicit instruction
> to research and cite them for the reviewer to sign off. Nothing ships unverified.

### Q-FIN-1 — SST registration status *(blocks Phase 3 invoicing)*

Is CAC SST-registered? If so: registration number, effective date, taxable service
category, and the rate applied to its services. If not registered, invoices must **not**
show tax.

> **Needed:** registration status and number, or written confirmation of non-registration.

### Q-FIN-2 — e-Invoice / MyInvois scope *(blocks Phase 4)*

Is CAC in scope yet, and from when? TIN required. Direct API or through an intermediary?
Sandbox credentials are needed before anything beyond an adapter is built.

> **Needed:** TIN, in-scope date, integration route, sandbox credentials.
> Until then: production-grade adapter + sandbox mock, clearly marked *awaiting credentials*.
> **No fake integration will be presented as working.**

**Status after Phase 4.** The boundary exists and refuses. `resolveProvider` returns a
provider that raises on every call, with a message naming what is missing; the MyInvois
adapter cannot even be constructed without a TIN, a client id, a client secret and an
explicit environment, so it cannot become active by accident or point at production by
default. Credentials are read from the server environment, never the settings table — a
client secret in a settings table is a client secret in every database backup.

One departure from the line above, and it is deliberate: **there is no sandbox mock.** A
stub that answers "validated" makes an invoice look compliant when nothing was sent, and
nobody finds out until LHDN asks. Exercising the flow needs a sandbox account, which
answers real validation errors; that is what the credentials in this question are for.

Three things CAC can settle now, none of which needs credentials and all of which take
longer than the integration:

1. **The company TIN** — a setting, `tax.tin`, currently empty.
2. **A TIN for every customer already invoiced** — MyInvois rejects an invoice without the
   buyer's. The e-Invoice screen lists which customers are missing one and how many
   invoices each has, so the collecting can start now rather than on the deadline.
3. **A classification code per service** — LHDN's own taxonomy, mapped onto CAC's six
   services. This is a judgement about what the firm does and is not guessed at; the
   adapter refuses to submit a line without one.

### Q-HR-1 — Statutory payroll sources *(blocks Phase 7)*

EPF is a **contribution schedule across wage bands**, not a percentage multiply, and the
same care applies to SOCSO, EIS and PCB. These must come from official current schedules.

> **Needed:** the current official schedules CAC's accountant accepts as authoritative,
> plus confirmation of employer/employee rates for CAC's staff categories.
> Payroll will not go live on approximated tables.

**Status after Phase 7.** Payroll is built and refuses to run. Everything around the
statutory figures works and is tested — the run lifecycle, reproducibility across rate
changes, the payslip PDF, the ledger posting, the return summary — and the figures
themselves are absent.

What is needed, per contribution, is the **table** rather than a rate:

1. **EPF** — the employee and employer schedules, which differ by age and wage band. Two
   separate rules, because the two shares are set independently.
2. **SOCSO and EIS** — the contribution tables. These are read by band: the amount is what
   the table says, not the wage multiplied by anything.
3. **PCB** — the deduction schedule, and how reliefs and categories are applied.
4. **HRD levy** — the rate and whether CAC is above the employee threshold at all.
5. **Overtime multiples** — for a normal day, a rest day and a public holiday (also needed
   by Phase 6, which can approve hours without a rate and leaves them unpaid).
6. **Which allowances count as wages** for each of the above. Not every allowance does, and
   the platform asks per element rather than assuming.

Each is entered with the document it came from and approved by a second person; after that
it is immutable, which is what makes a past payslip reproducible. A rate change is a new
version effective from the change date, and it does not disturb any earlier month.

> **Needed:** the official tables, per contribution, with the gazette or circular reference
> for each.

### Q-AI-1 — Approved AI provider for confidential data *(blocks Phase 10–11)*

Case files contain deceased persons' estates, NRICs and beneficiary details. Sending that
to an external model requires an approved provider under business terms with no training
on inputs.

> **Needed:** approved provider and account, confirmation of the data-processing terms,
> and whether client consent covers external processing.

### Q-ORG-1 — Who actually uses this *(blocks Phase 1 seeding)*

The site lists three people: Mr Mohaan (Director), Mr Shiva (Managing Director),
Mr Goku (Executive Consultant). An ERP with accounting, HR and payroll implies staff to
operate it.

> **Needed:** real headcount, who fills each role in `RBAC_MATRIX.md`, and whether payroll
> is run in-house or by an external agent. If HR/payroll is outsourced, Phases 5–8 may be
> deferred entirely — a large scope reduction worth knowing early.

---

## NON-BLOCKING

### Q-DATA-1 — Opening balances
Migrating from an existing system (AutoCount?) or starting fresh? Affects opening balance
import and the first period.

### Q-DATA-2 — Historical case files
How many past Probate/LA files, in what form (scanned PDF? paper?), and what quality?
Drives OCR effort and cost in Phase 10.

### Q-HR-2 — Attendance device
Make/model of the thumbprint machine and a **real sample export**. The importer is built
around the actual file, with mapping for variants. A sample is needed before Phase 5.

### Q-HR-3 — Leave entitlements *(new, raised by Phase 6)*
How many days of each kind of leave is somebody entitled to, and from where?

Annual and sick leave minimums are set by the Employment Act and depend on length of
service. CAC's own policy may grant more. Neither figure is authored here: **no entitlement
is seeded, and a leave type cannot hold a number without saying where the number came
from.** For statutory leave this is the difference between granting somebody their minimum
and guessing at it.

> **Needed:** per leave type — the entitlement (and how it varies with service, if it
> does), the citation or policy it comes from, how much may be carried forward, and whether
> it may be claimed after the fact.

**Status.** The leave module is built and works; the types table is empty of figures. A
request against a type with no entitlement is refused with a message naming this question,
and the leave screen lists which types are unusable and why. Everything else — counting
days against the working week and the holiday calendar, balances derived from approved
requests, approval by somebody other than the requester — is done and tested.

### Q-FIN-3 — Approval limits, and who may approve what *(referenced by Phases 2–3)*
Three documents ask the same question and none of them can answer it from the code:

- an **invoice** above some value should need a director rather than an accountant;
- a **payment voucher** above some value likewise, and money leaving is the more dangerous
  direction;
- a **purchase order** commits the firm before any money moves at all.

> **Needed:** the ringgit value at which each of those three needs the higher authority,
> and which role holds it.

**Status.** Invoices and payment vouchers each have a threshold setting, and both are
unset. While a threshold is unset the platform requires the *higher* authority for every
document of that kind — the conservative reading, so an unanswered question cannot quietly
let a large payment through on a junior approval. The refusal names the capability it
wanted and this question, rather than reading as a bare denial. Setting a value is an
administrator's change and is audited; it is not a code change.

Purchase orders have **no threshold at all** at present: one capability,
`accounting.po.approve`, covers any value, with maker/checker enforced so the person who
raised the order cannot approve it. That is deliberate rather than an oversight — inventing
a limit would be inventing a policy — but it does mean a large commitment and a small one
currently take the same signature. If CAC wants a director on orders above a value, say
what the value is and it becomes a setting like the other two.

### Q-FIN-4 — Existing chart of accounts
If one exists, it should be imported rather than invented.

**Status after Phase 2.** A default chart of 119 accounts is now seeded, built for what
CAC actually does — forensic investigation, land and title work, estate administration,
valuation, advisory — with Malaysian statutory payables split per contribution type. It is
a starting point, not a decision: accounts can be added, renamed and retired from the
application. If CAC already has a chart, send it and it will be mapped across. Doing that
*before* the first posting is far cheaper than afterwards, because an account that has
been posted to can no longer change its type or its parent.

### Q-FIN-5 — Who posts manual journals *(new, raised by Phase 2)*
Maker/checker pairs `accounting.journal.create` with `accounting.journal.post`, so the
person who prepares a manual journal cannot be the person who posts it. That is the right
control and it is on by default.

It also means that **if only one person at CAC holds `accounting.journal.post`, no manual
journal can ever be posted.** Two ways forward, and CAC picks:

1. **Two people hold it** — the accountant and one other (a director, or a second
   accountant). This is the recommendation; it is the control working as intended.
2. **Turn it off** — the setting `accounting.journal_requires_second_person`. Manual
   journals may then be self-posted, and every one of them is flagged `selfPosted: true`
   in the audit trail so the exception is visible rather than assumed.

There is no third option where the control is claimed and not enforced. Note this affects
manual journals only: an invoice or a payroll run is approved as a *document*, and its
ledger entry follows from that approval.

### Q-DOC-1 — Existing templates
Current Word templates for appointment letters, confirmation letters and case documents,
so the template engine matches what staff already use.

---

## CONFIGURABLE — built as settings, sensible defaults, no blocking

| Setting | Default until confirmed |
|---|---|
| Fiscal year start | 1 January |
| Accounting periods | Monthly |
| Invoice numbering | `INV-{YYYY}-{00000}` |
| Quotation / voucher / receipt / PO numbering | `QT-` / `PV-` / `RCP-` / `PO-{YYYY}-{00000}` |
| Quotation validity | 30 days |
| Invoice payment terms | 30 days |
| Approval threshold (MGMT → DIRECTOR) | **unset** — every approval routes to DIRECTOR until configured |
| Office hours | 09:00–18:00, Mon–Fri (matches the public site's stated hours) |
| Lunch break | 60 minutes, unpaid |
| Late grace period | 10 minutes |
| OT threshold | Beyond scheduled daily hours, **approval required** |
| OT rates | **unset** — no rate applied until Q-HR-1 resolves |
| Leave types / entitlement | Statutory minimum placeholders, flagged `NEEDS_REVIEW` |
| Leave approval chain | Manager → HR |
| Payroll cut-off | 25th |
| Pay date | Last working day |
| Departments | Seeded from the roster; editable |
| Authorised signatories | Director for letters; **unset** for financial documents |
| Aging buckets | Current, 1–30, 31–60, 61–90, 90+ |
| Currency | MYR (multi-currency architected, not enabled) |
| Timezone | Asia/Kuala_Lumpur |
| Session idle timeout | 30 minutes |
| Session absolute lifetime | 12 hours |
| MFA enforcement | On for all privileged roles |
| Password minimum | 12 characters + breach check |

Every one of these is a row in a settings table with an audit trail — changing a statutory
value records who changed it, when, and why.

---

## How these are handled in build order

- Phase 1 needs **Q-INFRA-1**, **Q-SEC-1**, **Q-ORG-1**.
- Phases 2–3 need **Q-FIN-1** before an invoice can legally be issued; the ledger itself
  can be built and tested without it.
- Phase 4 needs **Q-FIN-2**.
- Phases 5–8 need **Q-HR-1** before payroll runs; attendance and leave can proceed on
  **Q-HR-2**.
- Phases 9–12 need **Q-LEGAL-1**, **Q-LEGAL-2**, **Q-AI-1**.

Work that does not depend on an open question proceeds. Work that does is built up to the
boundary, with the gap explicit — never filled with a guess.
