# Aligning with AutoCount

CAC asked for the accounting and HR modules to be restructured to follow AutoCount — the
accounting and HRMS software most Malaysian SMEs and their accountants actually use. This is the
research behind that, what was adopted, what was deliberately not, and what is still missing.

The point of the exercise is not imitation. It is that CAC's staff, CAC's accountant and whoever
audits CAC already have AutoCount's vocabulary in their heads. A platform that calls the same
things by the same names, and puts them in the same order, is one nobody has to be taught twice.

---

## 1. What AutoCount actually is

Two separate products, sold separately, that talk to each other over an API.

**AutoCount Accounting** (desktop v2, and AutoCount Cloud Accounting) organises everything under
eight menus:

| Menu | What lives there |
| --- | --- |
| **General Maintenance** | Account books, company profile, users, access rights, import/export |
| **G/L** | Account Maintenance (chart of accounts), Journal Entry, Cash Book Entry, Opening Balance, Bank Reconciliation, Foreign Currency Revaluation, Budget, Fixed Asset Disposal, Stock Value; reports — Ledger, Trial Balance, Profit & Loss, Balance Sheet |
| **A/R** | Debtor Maintenance, Invoice Entry, Payment Receipt, Credit Note, Debit Note, Deposit Entry; reports — Aging, Statement of Account, Collection Analysis |
| **A/P** | Creditor Maintenance, Invoice Entry, Payment, Credit Note, Debit Note, Deposit Entry; the same reports on the other side |
| **Sales** | Quotation → Sales Order → Delivery Order → Invoice, plus Cash Sale, Credit/Debit Note, Consignment |
| **Purchase** | Purchase Request → RFQ → Purchase Order → Goods Received Note → Purchase Invoice, plus Cash Purchase, Returns |
| **Stock** | Item Maintenance, adjustments, transfers, assembly, stock take |
| **Tools** | Tax Code Maintenance, Audit Trail, Backup/Restore, Options |

Two structural ideas matter more than the menu names:

1. **A/R and A/P are mirrors of each other.** Every document on the customer side has a supplier-
   side twin, with the same lifecycle and the same reports. An accountant who has learned one has
   learned both.
2. **Documents flow, and the flow is visible.** Quotation becomes sales order becomes delivery
   order becomes invoice becomes receipt. AutoCount has a "View Flow" screen that shows the whole
   chain from any document in it, and an access right controlling who may see it.

**AutoCount HRMS / Cloud Payroll** is modular: Payroll, plus eLeave, eClaim and eAttendance bought
separately. Its setup order is fixed and worth copying because it is the order the dependencies
run in: company profile → bank account for salary → allowances and deduction formulas → company
calendar and rest days → employees → then, monthly: attendance → process payroll → review draft →
commit → bank payment file → statutory files.

The statutory outputs are the part CAC cannot do without, because they are the reason a Malaysian
firm buys payroll software at all rather than using a spreadsheet:

| Output | Body | When | Format |
| --- | --- | --- | --- |
| EPF Form A | KWSP | 15th of the following month | TXT |
| SOCSO Borang 8A | PERKESO | 15th | TXT |
| EIS / SIP | PERKESO | 15th | TXT |
| PCB (monthly tax deduction) | LHDN | month end | TXT / XML |
| HRDF levy | HRD Corp | 15th | portal format |
| CP22 / CP22A / CP21 | LHDN | within 30 days of hire / cessation / departure | form |
| Form E + CP8D | LHDN | 31 March | PDF + TXT |
| EA Form (C.P.8A) | to each employee | 28 February | PDF + TXT |
| Bank salary batch | the company's bank | payday | bank-specific TXT |

Payroll posts to accounting through a mapping: each pay item is assigned a general ledger account,
and committing a period produces a journal. AutoCount's own posting is coarse — its guide states
there is no branch, department, employee group or project grouping in the posted journal.

Sources: [AutoCount Accounting 2.0 help file](https://wiki.autocountsoft.com/wiki/Category:AutoCount_Accounting_2.0:HelpFile),
[View Documents Flow](https://autocountsystem.com/knowledge-base/autocount-accounting-features/view-flow/),
[AutoCount Accounting](https://autocountsystem.com/autocount-accounting2/),
[AutoCount HRMS](https://www.autocountsoft.com/pro-payroll.html),
[how to start HRMS](https://www.autocountsoft.me/how-to-start-hrms),
[payroll posting guide](https://wiki.autocountsoft.com/wiki/Cloud_Payroll_-_User_Guide_for_Payroll_Posting_v1),
[statutory payroll reporting in Malaysia](https://autocountsystem.com/statutory-payroll-reporting-malaysia/).

---

## 2. What CAC is, and why that changes the answer

CAC is a property-forensics consultancy. It sells professional time and findings: investigations,
appraisals, letters of administration and probate work. It does not hold stock, deliver goods,
assemble items or consign anything.

So parts of AutoCount are adopted, parts are adapted, and parts are **deliberately left out**. The
left-out list is written down here rather than quietly skipped, because a menu that is missing
something the reader expected should say why.

### Adopted

- **The A/R and A/P split**, as the organising principle of the accounting module — replacing a
  flat list of nineteen document types in no particular order.
- **The document flow**, made visible from any document in the chain.
- **The G/L menu shape**: chart of accounts, journals, opening balances, bank reconciliation,
  periods, tax codes, then the four statements.
- **AutoCount's names** where CAC had invented its own. "Debtor"/"Creditor" are kept as the
  *module* names A/R and A/P while the screens keep "Customers" and "Suppliers", which is what
  AutoCount Cloud itself now does.
- **The HRMS setup order**, as the order of the HR menu.
- **The statutory output set**, in full.

### Adapted

- **Sales Order** exists in AutoCount between quotation and delivery. For CAC there is nothing to
  deliver, but the stage is real: an accepted quotation is an engagement that is not yet billable.
  CAC already models this as a quotation with status `accepted`; it becomes a first-class
  **Engagement** rather than an invented "sales order" for goods that do not exist.
- **Delivery Order / Goods Received Note** have no meaning without goods. The step a GRN performs
  — confirming that what was ordered actually arrived before the bill is paid — *does* matter, and
  it lives on the purchase order as receipt confirmation, which CAC already has
  (`receivePurchaseOrder`).
- **Cash Sale** is an invoice settled at issue. CAC's receipt allocation already expresses this;
  no separate document type.

### Deliberately not adopted

| AutoCount has | Why CAC does not |
| --- | --- |
| Stock / Item Maintenance / stock take | CAC holds no inventory. A stock module with nothing in it is a menu that lies. |
| Item Assembly, Multi-UOM, Serial Numbers, Consignment, Landing Cost | All inventory features. |
| Multi-currency and FX revaluation | CAC invoices in MYR. Worth revisiting the day it does not; building it now means an untested revaluation path in the ledger. |
| Multiple account books | One company. AutoCount's account-book concept exists for bureaus running many clients' books. |
| Branch / project / department dimensions | CAC has departments in HR. The ledger's analytical dimension is the **matter** (case), which is what CAC's revenue is actually attributable to, and which AutoCount has no equivalent of. |

---

## 3. Gap analysis

Measured against AutoCount, and against what a Malaysian consultancy actually has to produce.

### Accounting

| # | Gap | Severity | Note |
| --- | --- | --- | --- |
| ~~A1~~ | ~~**No supplier invoice as a document.**~~ **Built.** `accounting.supplier_invoice`, its lines and `accounting.payable_settlement` (migrations 0039/0040), with the same lifecycle, maker/checker and derived totals as the sales side. A bill carries both references — CAC's own and the supplier's — and the supplier's is unique per supplier, so the same invoice cannot be entered twice. | — | `packages/core/src/payables.ts` |
| ~~A2~~ | ~~**No payables aging.**~~ **Built.** `payablesAging`, the mirror of `receivablesAging`, reconciling against account 2110. The first run of that reconciliation failed by 1,350.00 and found a real gap: settlement vouchers debit the control account the moment they post, whether or not anybody has said which bill they settle, so the report has a `paymentsOnAccount` column and the difference is nil. A supplier statement is still outstanding. | Low | The statement is the remaining half. |
| A3 | **No debit notes**, on either side. Credit notes exist. | Medium | A debit note is how an undercharge is corrected without voiding and reissuing. |
| A4 | **No customer deposit / advance received.** | Medium | CAC takes deposits on engagements. Today one is a receipt with nothing to allocate against. |
| A5 | **No fixed asset register.** The seeded chart has accumulated-depreciation accounts, so the chart expects assets the system cannot record. | Medium | Depreciation is currently a manual journal. |
| A6 | **No budget.** | Low | AutoCount has Budget Maintenance and budget-vs-actual. |
| A7 | **No document flow view.** The links exist in the data; nothing shows the chain. | Medium | Cheap, and the single most recognisable AutoCount affordance. |
| A8 | **No opening balance flow.** Balances can only arrive by journal. | Medium | Matters exactly once, at go-live, which is the worst time to improvise. |

### HR and payroll

| # | Gap | Severity | Note |
| --- | --- | --- | --- |
| H1 | **No statutory submission files at all** — no EPF Form A, SOCSO Borang 8A, EIS, PCB CP39. `statutorySummary` computes the figures; nothing writes the file the portal wants. | **Highest** | Without these, payroll ends in somebody retyping into three portals. This is the reason firms buy AutoCount HRMS. |
| H2 | **No EA Form, no Form E / CP8D.** | **High** | Annual, statutory, and non-negotiable — EA by 28 February, Form E by 31 March. |
| H3 | **No CP22 / CP22A / CP21** on hire, cessation and departure. | High | 30-day statutory deadlines that nothing currently tracks. |
| H4 | **No bank salary payment file.** | High | Payday is currently manual. |
| H5 | **No shift or work-pattern management.** Attendance assumes one schedule. | Medium | AutoCount's eAttendance manages fixed and flexible shifts. |
| H6 | **Claims live under Accounting, not HR.** AutoCount's eClaim is an HR module with per-employee entitlements, limits and multi-tier approval. | Medium | CAC's claim is an accounting expense claim with no entitlement concept. |
| H7 | **No HRDF levy.** | Medium | Applies above the headcount threshold; CAC to confirm whether it is registered. |
| H8 | **No multi-tier leave entitlement** (by grade or length of service). | Medium | |

### What is already equal to or better than AutoCount

Worth recording, so the restructure does not throw it away:

- **Matter-level revenue attribution.** AutoCount has no equivalent; its own payroll posting guide
  admits it cannot even group by department.
- **Maker/checker on every document**, with approval thresholds, and an approver who cannot be the
  maker. AutoCount has access rights, not separation of duties.
- **An append-only audit trail** that records who produced every document, with no ability to edit
  a past entry.
- **Statutory rates as approved, dated rule versions** rather than constants in the program — so a
  payroll run is reproducible against the rates that were in force on its own date.
- **MyInvois e-Invoicing** with a submission path.
- **Three-valued rules** in the case engine: a requirement can be *undecided* with a list of what
  is missing, rather than silently false.

---

## 4. The plan

Ordered by what stops work today.

1. ~~**Restructure the information architecture**~~ **Done.** G/L, A/R (Sales & receivables), A/P
   (Purchases & payables), and HR in AutoCount HRMS's setup order. No behaviour change.
2. ~~**A1 + A2 — the payables sub-ledger.**~~ **Done**, ahead of the statutory work, because it is
   the structural half of what CAC asked for: it is the A/R↔A/P mirror that is AutoCount's
   organising idea, and without it "restructured to follow AutoCount" would have been a menu
   rename.
3. **H1 + H2 + H4 — the statutory and bank outputs.** The file layouts are published by KWSP,
   PERKESO and LHDN; they are *not* to be inferred. Each layout is entered as an approved,
   dated specification the same way statutory rates are, and the generator refuses to emit a file
   for a layout nobody has confirmed. A wrong fixed-width file is worse than no file: it is
   accepted by the portal and rejected weeks later.
4. **A7 — the document flow view.**
5. **A3, A4, A8 — debit notes, deposits, opening balances, and the supplier statement.**
6. **H3 — CP22/CP22A/CP21 and the 30-day clocks.**
7. **H5, H6, H8 — shifts, claim entitlements, tiered leave.**
8. **A5, A6 — fixed assets and budget.**

## 5. Noticed in passing, not fixed

`PurchaseForm` produces a React "each child in a list should have a unique key" warning in
development. It predates this work — it appears on the voucher, order and claim screens as well as
the new bill screen — it is a development-only warning, and it changes nothing about what renders.
Recorded rather than quietly left, and rather than fixed in a change that is about something else.

Items needing CAC's answer before they can be built honestly are raised in
`docs/OPEN_QUESTIONS.md` rather than guessed at.
