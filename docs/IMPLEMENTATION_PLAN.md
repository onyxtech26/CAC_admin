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

---

## Phase 5 — HR foundation *(needs Q-HR-2 sample file)*

Employees, departments, positions, work schedules · **thumbprint Excel import** with
staging, column mapping, validation, preview, error report and explicit confirmation.

**Exit:** a real export from CAC's device imports, with bad rows rejected and reported,
and nothing reaching final attendance without HR confirmation.

---

## Phase 6 — HR workflows

Attendance calculation engine (late, early-out, extra time, missing clock, overnight
shifts, public holidays, leave overlap) · overtime requests · leave · time-off and
early-clock-out · claims · appraisals.

> **Extra time ≠ payable overtime.** Extra time is calculated; payable OT is a separate
> decision gated on eligibility, company rule, statute and approval.

---

## Phase 7 — Payroll *(needs Q-HR-1 — will not proceed without official schedules)*

Payroll run lifecycle · EPF/SOCSO/EIS/PCB via **versioned, effective-dated**
`statutory_rule_version` · payslip PDF · posting to the ledger.

**Exit:** payroll is reproducible — rerunning a past period with its recorded rule version
produces identical output after rules change. Payslips are private to the employee.

---

## Phase 8 — HR documents

Template-driven appointment and confirmation letters, DOCX + PDF, versioned, approved,
immutable once issued.

---

## Phase 9 — Case management *(needs Q-LEGAL-1)*

Probate and LA case records · parties, assets, liabilities · tasks · timeline ·
**dynamic checklists** (scenario-driven, never a fixed list per case type) · documents.

---

## Phase 10 — Knowledge ingestion *(needs Q-AI-1, Q-DATA-2)*

Upload → malware scan → checksum → classify → OCR where needed → extract → chunk →
embed → index. Provenance on every chunk (document, page, method, confidence). Originals
retained immutably. Hybrid retrieval, permission-filtered in SQL.

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
