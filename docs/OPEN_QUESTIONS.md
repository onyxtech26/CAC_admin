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

### Q-HR-1 — Statutory payroll sources *(blocks Phase 7)*

EPF is a **contribution schedule across wage bands**, not a percentage multiply, and the
same care applies to SOCSO, EIS and PCB. These must come from official current schedules.

> **Needed:** the current official schedules CAC's accountant accepts as authoritative,
> plus confirmation of employer/employee rates for CAC's staff categories.
> Payroll will not go live on approximated tables.

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
