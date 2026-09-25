# CAC — RBAC Matrix

Roles are **bundles of capabilities**. Application code always checks a capability, never
a role name. Deny-by-default; an explicit user-level `deny` beats any role grant.

---

## 1. Roles

| Key | Intent |
|---|---|
| `SUPER_ADMIN` | Platform administration. Not an everyday account. |
| `DIRECTOR` | Company leadership. Final approval above thresholds. |
| `MANAGEMENT` | Senior oversight, reporting, approvals within limits. |
| `ACCOUNTANT` | Owns the ledger: posting, periods, statutory reporting. |
| `ACCOUNTS_EXECUTIVE` | Prepares accounting documents. Cannot approve or post. |
| `HR_ADMIN` | HR operations, attendance, leave administration, payroll preparation. |
| `HR_MANAGER` | HR oversight and payroll approval. |
| `CASE_MANAGER` | Owns estate cases end to end. |
| `CASE_STAFF` | Works assigned cases. Cannot approve legal documents. |
| `LAWYER_OR_AUTHORISED_REVIEWER` | Approves legal documents and case rules. |
| `EMPLOYEE` | Self-service only: own payslips, leave, claims, attendance. |
| `AUDITOR` | Read-everything, change-nothing, including the audit trail. |
| `READ_ONLY` | Limited read access for observers. |

---

## 2. Capabilities

Format: `<domain>.<entity>.<action>`.

**Accounting** — `accounting.coa.{view,manage}` · `invoice.{view,create,edit,approve,issue,void}` ·
`quotation.{view,create,edit,approve,convert}` · `receipt.{view,create,allocate,approve}` ·
`voucher.{view,create,approve,pay}` · `po.{view,create,approve,receive,close}` ·
`pettycash.{view,create,approve,reconcile}` · `claim.{view,create,approve,reimburse}` ·
`journal.{view,create,post,reverse}` · `period.{view,manage,lock,close}` ·
`tax.{view,manage}` · `bank.{view,manage,import,match,reconcile}` · `report.{view,export}` ·
`einvoice.{submit,cancel,view}` · `customer.{view,manage}` · `supplier.{view,manage}`

> **Bank, split four ways on purpose.** Importing a statement and matching what is obvious
> is day-to-day work and sits with `ACCOUNTS_EXECUTIVE` as well as the accountant. Saying
> the account *is* reconciled is a conclusion about the firm's books, and `bank.reconcile`
> stays with whoever owns the ledger. `bank.manage` — attaching a real account to a ledger
> account — is separate again, because it decides what every future reconciliation is
> measured against.

**HR** — `hr.employee.{view,view_sensitive,create,edit,terminate}` ·
`attendance.{view,import,edit,finalise}` · `schedule.{view,manage}` ·
`overtime.{view,request,approve}` · `leave.{view,request,approve,manage_types,manage_balance}` ·
`timeoff.{request,approve}` · `payroll.{view,prepare,approve,finalise,post}` ·
`payslip.{view_own,view_all}` · `appraisal.{view,manage,review}` ·
`letter.{generate,approve}` · `statutory.{view,manage}`

**Cases** — `case.{view,view_all,create,edit,assign,close}` ·
`case.document.{upload,view,download,delete}` · `case.checklist.manage` ·
`case.task.{view,manage}` · `case.agent.run` · `case.document.{generate,approve}` ·
`case.fact.verify` · `case.rule.{view,propose,approve}`

**Documents** — `doc.{view,upload,download,delete,archive}` · `template.{view,manage,approve}`

**Admin / audit** — `admin.user.manage` · `admin.role.manage` · `admin.settings.manage` ·
`admin.integration.manage` · `audit.view` · `audit.export`

---

## 3. Matrix

`✓` granted · `○` own records only · `△` within configured threshold · blank = denied

**`SUPER_ADMIN` is almost entirely blank, and that is the point.** It administers users,
roles and settings, and it reads the audit trail. It cannot approve an invoice, post
payroll or approve a legal document. A platform administrator who is also a business
super-user makes maker/checker unenforceable and the audit trail unfalsifiable: every
disputed entry has a second possible author who can do anything. Whoever administers the
platform is given a business role *as well*, by somebody else, and the trail shows it.
`packages/core/src/authz.test.ts` asserts this rather than trusting the table.

| Capability | SUPER | DIR | MGMT | ACCT | AE | HR_ADM | HR_MGR | CASE_MGR | CASE_ST | LAWYER | EMP | AUDIT | RO |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `accounting.coa.view` | ✓ | ✓ | ✓ | ✓ | ✓ | | | | | | | ✓ | ✓ |
| `accounting.coa.manage` |   | | | ✓ | | | | | | | | | |
| `invoice.view` |   | ✓ | ✓ | ✓ | ✓ | | | ✓ | | | | ✓ | ✓ |
| `invoice.create` |   | | | ✓ | ✓ | | | | | | | | |
| `invoice.approve` |   | ✓ | △ | ✓ | | | | | | | | | |
| `invoice.issue` |   | | | ✓ | | | | | | | | | |
| `invoice.void` |   | ✓ | | ✓ | | | | | | | | | |
| `receipt.create` |   | | | ✓ | ✓ | | | | | | | | |
| `receipt.approve` |   | ✓ | | ✓ | | | | | | | | | |
| `voucher.create` |   | | | ✓ | ✓ | | | | | | | | |
| `voucher.approve` |   | ✓ | △ | ✓ | | | | | | | | | |
| `pettycash.approve` |   | ✓ | ✓ | ✓ | | | | | | | | | |
| `claim.create` |   | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | |
| `claim.approve` |   | ✓ | ✓ | ✓ | | ✓ | ✓ | | | | | | |
| `journal.post` |   | | | ✓ | | | | | | | | | |
| `journal.reverse` |   | ✓ | | ✓ | | | | | | | | | |
| `period.manage` |   | ✓ |   | ✓ | | | | | | | | | |
| `period.close` |   | ✓ | | ✓ | | | | | | | | | |
| `tax.manage` |   | | | ✓ | | | | | | | | | |
| `einvoice.submit` |   | | | ✓ | | | | | | | | | |
| `accounting.report.view` |   | ✓ | ✓ | ✓ | ✓ | | | | | | | ✓ | ✓ |
| `hr.employee.view` | ✓ | ✓ | ✓ | | | ✓ | ✓ | | | | ○ | ✓ | |
| `hr.employee.view_sensitive` |   | ✓ | | | | ✓ | ✓ | | | | ○ | ✓ | |
| `hr.employee.edit` |   | | | | | ✓ | ✓ | | | | | | |
| `attendance.import` |   | | | | | ✓ | ✓ | | | | | | |
| `attendance.finalise` |   | | | | | | ✓ | | | | | | |
| `overtime.approve` |   | ✓ | ✓ | | | ✓ | ✓ | ✓ | | | | | |
| `leave.approve` |   | ✓ | ✓ | | | ✓ | ✓ | ✓ | | | | | |
| `payroll.prepare` |   | | | | | ✓ | ✓ | | | | | | |
| `payroll.approve` |   | ✓ | | | | | ✓ | | | | | | |
| `payroll.finalise` |   | ✓ | | | | | ✓ | | | | | | |
| `payroll.post` |   | | | ✓ | | | | | | | | | |
| `payslip.view_own` |   | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | |
| `payslip.view_all` |   | ✓ | | | | ✓ | ✓ | | | | | ✓ | |
| `statutory.manage` |   | ✓ | | ✓ | | | ✓ | | | | | | |
| `letter.generate` |   | | | | | ✓ | ✓ | | | | | | |
| `letter.approve` |   | ✓ | | | | | ✓ | | | | | | |
| `case.view` |   | ✓ | ✓ | | | | | ✓ | ○ | ✓ | | ✓ | |
| `case.view_all` | ✓ | ✓ | ✓ | | | | | ✓ | | ✓ | | ✓ | |
| `case.create` |   | | | | | | | ✓ | | | | | |
| `case.edit` |   | | | | | | | ✓ | ○ | | | | |
| `case.document.upload` |   | | | | | | | ✓ | ○ | | | | |
| `case.agent.run` |   | ✓ | | | | | | ✓ | ○ | ✓ | | | |
| `case.document.generate` |   | | | | | | | ✓ | ○ | ✓ | | | |
| `case.document.approve` |   | ✓ | | | | | | | | ✓ | | | |
| `case.fact.verify` |   | | | | | | | ✓ | | ✓ | | | |
| `case.rule.propose` |   | | | | | | | ✓ | | ✓ | | | |
| `case.rule.approve` |   | ✓ | | | | | | | | ✓ | | | |
| `admin.user.manage` | ✓ | | | | | | | | | | | | |
| `admin.role.manage` | ✓ | | | | | | | | | | | | |
| `admin.settings.manage` | ✓ | ✓ | | | | | | | | | | | |
| `audit.view` | ✓ | ✓ | | | | | | | | | | ✓ | |
| `audit.export` | ✓ | ✓ | | | | | | | | | | ✓ | |

---

## 4. Rules the matrix cannot express

1. **Maker/checker.** The creator of an invoice, voucher, claim, payroll run or case
   document may never approve it — regardless of capability. Enforced server-side.
2. **Thresholds (`△`).** `MANAGEMENT` approval is bounded by a configurable amount;
   above it, `DIRECTOR` is required. **Threshold value is unset — Q-FIN-3.**
3. **Own-record scope (`○`).** `EMPLOYEE` sees only their own employment record,
   payslips, leave and claims. `CASE_STAFF` sees only assigned cases. Enforced in the
   query predicate, not the UI.
4. **`AUDITOR` is strictly read-only**, including the audit log itself. No write
   capability exists for this role in any domain.
5. **`SUPER_ADMIN` is not a business role.** It administers users, roles and integrations.
   It does **not** bypass maker/checker, and its actions are audited like any other.
6. **Legal approval cannot be delegated.** `case.document.approve` and
   `case.rule.approve` sit only with `LAWYER_OR_AUTHORISED_REVIEWER` (and `DIRECTOR`).
   **Who holds this in reality is unresolved — Q-LEGAL-1.**
7. **Releasing a file from quarantine is not an upload.** `doc.archive` is what releases a
   document no scanner has looked at, and it sits with `CASE_MANAGER` and `DIRECTOR` — not
   with everybody who holds `doc.upload`. A released document is recorded as *released
   unscanned*, never as clean.
8. **`doc.delete` destroys an original.** It sits with `DIRECTOR` alone. Everybody else
   archives, which keeps the bytes and only removes the document from search.

---

## 5. Testing

Permission tests are mandatory, not optional. For every capability:

- a holder succeeds;
- a non-holder receives 403 **from the server**, with the UI bypassed entirely;
- scope is honoured (employee A cannot read employee B's payslip by changing an id);
- maker/checker cannot be defeated by a second session for the same user;
- a `deny` grant overrides a role grant.
