# CAC — Hardening

What was tested, what was measured, what is monitored, and what has to happen before any of this
goes near real client data. Backup and restore has its own document:
`docs/BACKUP_AND_RECOVERY.md`.

---

## 1. Permission testing

Two halves, because neither alone is sufficient.

### The runtime half: a holder succeeds, a non-holder is refused

Every module's own test file proves this for the capabilities it uses, and there are 711 tests
across the suite. The refusal comes from the server, with the UI bypassed entirely — the tests call
the core functions directly, so a screen that forgot to hide a button is irrelevant to whether the
operation is permitted.

What is covered per module, beyond the plain allow/deny:

- **Scope.** An employee reading another employee's payslip by changing an id gets an
  `AuthorizationError`, not a payslip. A case document belonging to a matter somebody is not
  assigned to is invisible to them *including through search* — the clause is in the query.
- **Maker and checker.** The creator of an invoice, a voucher, a journal, a payroll run, a letter,
  a case rule or a case document cannot approve their own. Enforced per record rather than per
  role, because somebody can legitimately hold both capabilities across different documents — and
  in several modules the database enforces it as well.
- **Absence as a state.** An unconfigured malware scanner, OCR engine, embedding model, e-Invoice
  provider or drafting model refuses and says what is missing. None of them has a stub that
  reports success.

### The structural half: the shape of the catalogue

`packages/core/src/hardening.test.ts` asks questions no single module can:

| Check | Why it exists |
|---|---|
| Every defined capability is granted to at least one role | `doc.archive` and `doc.delete` were defined, checked in code, and granted to nobody — so nobody could archive a document or destroy an original, and nothing failed loudly enough to notice. |
| Every granted capability is defined | A typo in a role bundle grants nothing at all, and the only symptom is a screen that never appears. |
| The database matches the code, in both directions | The seed rebuilds role grants from the catalogue each run; a drift between them means the running system is not the documented one. |
| Every approver is paired with its maker in `MAKER_CHECKER_PAIRS` | Five pairs existed in the catalogue and were undeclared — quotation, receipt, purchase order, petty cash and employment letters. The pairing lived in whichever function happened to call `requireDifferentApprover` and nowhere else. |
| The two legal approvals sit only with the reviewer and the director | `CASE_MANAGER` was built with `has("case.")`, which handed it both — contradicting `docs/RBAC_MATRIX.md`. The code was wrong. |
| `doc.delete` sits with the director alone | Destroying an original is the one operation in the document pipeline that cannot be undone. |
| `AUDITOR` and `READ_ONLY` hold nothing that writes | Asserted against the whole resolved set, not a sample. |
| `SUPER_ADMIN` is not a business super-user | It administers users, roles and settings, and cannot approve an invoice, post payroll or approve a legal document. |
| A direct `deny` beats a role grant; a direct `allow` adds one without a role | What actually happens when somebody's duties change. |
| Revoking a role takes effect immediately | Capabilities are resolved per request rather than cached on the session. |
| Every append-only table has an UPDATE trigger | Four of them: the audit trail, the case timeline, the ingestion log and the employment history. |
| Migrations are numbered without gaps | A gap means a file was renamed or deleted after it had been applied somewhere. |

**Four real defects were found this way**, all of them in the permission model rather than in a
feature: the two orphaned document capabilities, the five undeclared maker/checker pairs, the case
manager holding both legal approvals, and a `template.*` family of three capabilities that gated
nothing at all — removed in migration 0026, because a capability that grants access to nothing is a
false statement in the matrix somebody reads to decide who may do what.

### The route half: no page without a guard

```bash
node scripts/check-route-guards.mjs
```

Walks `apps/staff/src/app` and asserts that every `page.tsx` and `route.ts` calls a server-side
guard. Result: **94 routes checked, every one guarded**, with five deliberately public and each of
those carrying its reason in the script.

This exists because the runtime tests cannot catch a *new* page that simply forgets to ask — a
screen that renders a family's estate to anybody who guesses the URL, because the author copied a
file and deleted the wrong line. Hiding the nav item is presentation, and the nav item is exactly
what an author remembers to add.

The script initially reported two failures, and both were the script's fault rather than the code's:
a file-serving route handler legitimately reads the principal and answers 401 or 403 rather than
redirecting, because redirecting a PDF download to `/login` produces an HTML page with a `.pdf`
filename. That pattern is now recognised, and the distinction is written down in the script.

---

## 2. Performance

```bash
pnpm --filter @cac/db perf              # the numbers
CAC_PERF_EXPLAIN=1 pnpm --filter @cac/db perf   # and the plan for the one that costs anything
```

Measured against a synthetic dataset of 400 matters, 2,000 assets, 1,600 documents and 19,200
indexed passages. Each read is run twice and the repeat is reported, with the first beside it.

| Query | Repeat | First |
|---|---|---|
| Case list with outstanding and task counts (the `/cases` query) | 4.0 ms | 5 ms |
| Estate position for one matter | 0.7 ms | 2 ms |
| Full-text search, English, permission-filtered | 28.4 ms | 47 ms |
| Full-text search, a term matching every passage | 41.3 ms | 42 ms |
| Full-text search, `simple` configuration (the Malay path) | 4.2 ms | 4 ms |
| Audit trail, newest first | 0.9 ms | 1 ms |
| Trial balance | 1.5 ms | 2 ms |

Nothing is quadratic. The one figure worth keeping an eye on is the fourth: a query term that
appears in every passage costs 41 ms because the index finds everything and the work becomes
*ranking* the corpus rather than searching it. The plan confirms the GIN index is used and the sort
is a bounded top-N heapsort; this is simply what ranked full-text search costs when a query is not
selective, and it scales with the number of matches. At CAC's volumes that is comfortable. If the
library ever reaches a scale where it is not, the fix is to bound the candidate set before
ranking — which returns a good answer rather than the best one, and should therefore be a
deliberate decision rather than a silent optimisation.

**These figures do not predict production and are not offered as if they did.** They are measured
against PGlite — PostgreSQL compiled to WebAssembly — which is slower than a real server by a
constant factor. That is useful precisely because of it: a query that is comfortable here is
comfortable anywhere, and one that is slow here is worth looking at before it reaches a server that
hides it. There is no production to predict until Q-INFRA-1 is answered.

> One measurement was wrong before it was right, and it is worth recording why. The first run of
> the probe reported the English search at 197 ms. The cause was the synthetic corpus: every
> passage held identical text, so every query matched all 19,200 rows and the probe was measuring
> ranking rather than searching. Varying the corpus brought it to 28 ms. A benchmark that is
> accidentally degenerate reports a problem that does not exist, and acting on it would have meant
> optimising something that was never slow.

---

## 3. Monitoring

`GET /api/health` answers twice over, deliberately.

- **Unauthenticated:** `{"ok":true}`, or `{"ok":false}` with a 503. That is what a load balancer or
  an uptime check needs, and it is all a stranger should learn. A health endpoint that volunteers
  the schema version, the migration count and the list of integrations is a reconnaissance
  endpoint.
- **To `admin.settings.manage`:** the schema version and migration count, a handful of counts
  (active users, settings still unset, documents in quarantine, approved case rules), and — the
  part that matters most here — which of the four configured-elsewhere dependencies are present.

That last field is the one worth having. The malware scanner, the OCR engine, the embedding model
and the drafting assistant are each absent by design and each refuses rather than pretending. A
deployment that silently lost its scanner configuration would otherwise look identical to one that
never had any.

No secret, no connection string and no key reaches either answer, and a failure logs its detail
server-side rather than returning it.

**What is not built:** metrics, traces, alerting. Those need somewhere to send them, which is
Q-INFRA-1. Structured request logging with a correlation id already exists — every audit row
carries one — and that is the useful half of tracing for a system of this size.

---

## 4. User acceptance

UAT is not something this document can perform. What it can do is state the entry conditions, and
they are not all met.

### Ready to be tested now

| Area | What a tester can do end to end |
|---|---|
| Authentication | Sign in, second factor, password change on a handover password, lockout, session revocation |
| Accounting | Quotation → invoice → receipt → allocation; purchase order → voucher; petty cash; claims; journals; the four reports |
| Bank | Import a statement, match, post from a line, complete a reconciliation |
| HR | Employees, organisation, attendance import from a device file, leave, overtime, appraisals |
| Payroll | A run, its payslips and its posting — **only once statutory tables are entered** (below) |
| Letters | Template, approval, generation, DOCX and PDF, supersession |
| Cases | Intake, the file, the checklist, tasks, the timeline — **the checklist only once rules are entered** |
| Documents | Upload, quarantine, release, extraction, search, archive |
| Case documents | Template, approval, generation, review, finalisation, correction |

### Blocked, and by what

| Area | Blocked by |
|---|---|
| Payroll figures | **Q-HR-1.** No statutory table is seeded; a run refuses without them, naming which are missing. Nothing about EPF, SOCSO, EIS or PCB can be accepted until CAC supplies the schedules with their sources. |
| Case checklists | **Q-LEGAL-1, Q-LEGAL-2.** No requirement rule is seeded. A matter's checklist is empty, and correctly says why. |
| Approving any legal document | **Q-LEGAL-1.** Refused until an administrator confirms a named, qualified reviewer has been appointed — including for a director. |
| Leave entitlements | **Q-HR-3.** Nullable, with a required source. Nothing is seeded. |
| Overtime rates | **Q-HR-1.** A claim can be approved with hours agreed and no rate; payroll then refuses to pay it, putting a nil line on the payslip saying why. When CAC answers, the rate is recorded on the approved claim without reopening the decision, and a supplementary run pays it on that month's rules. |
| e-Invoice submission | **Q-FIN-2.** The boundary exists; the provider refuses. |
| Anything needing a malware scan, OCR or semantic search | **Q-AI-1, Q-DATA-2.** Each refuses rather than pretending. |
| Approval thresholds | **Q-FIN-3.** Unset. |

A tester should be given this table before they start. Half of "the system does not do X" turns out
to be "X is a decision nobody has made yet", and discovering that during UAT wastes the tester's
day.

---

## 5. Cutover

Not performed, and it should not be until the following are true. This is a checklist to be worked
through, not a description of something that happened.

**Blocking, technically**

1. **Q-INFRA-1 answered.** Where this runs decides the database, the backup target, the secret
   store and the deployment. PGlite behind a single Next.js instance is correct for development and
   is not a production posture: it is single-writer, the data directory is a local path, and there
   is no off-site copy.
2. **A real secret store.** The encryption key, the session secret and any provider credentials.
   Today's arrangement is documented in `docs/SECURITY_MODEL.md` and is a development one.
3. **An off-site backup with a verified restore** *in the production shape* — the commands in
   `docs/BACKUP_AND_RECOVERY.md` verify a PGlite archive, and a hosted server needs the same
   verification against its own snapshots and `pg_dump`.
4. **TLS, and the session cookie's `secure` flag turned on with it.**
5. **A second administrator.** `docs/SECURITY_MODEL.md` records the gap: an administrator who loses
   their authenticator cannot be recovered by the console, and resetting MFA needs a second
   administrator. One administrator plus one lost phone is a locked platform.

**Blocking, before real data**

6. **The statutory tables** (Q-HR-1) — payroll refuses without them, which is correct, and means
   no payroll can run.
7. **The legal reviewer appointed and confirmed** (Q-LEGAL-1) — no legal document can be approved
   until then.
8. **A retention policy** for documents and backups. Both are personal data; keeping them forever
   is its own exposure.
9. **No CAC client or employee data in any fixture.** Asserted by the tests today — every fixture
   is an invented person — and worth re-checking at cutover, because the temptation appears with
   the first real import.

**The sequence, when those are true**

1. Freeze the current system of record. Whatever CAC uses today stops being written to at a stated
   moment.
2. Migrate reference data first: chart of accounts, tax codes, customers, suppliers, employees.
   Reconcile counts before going further.
3. Enter opening balances as a dated journal, and prove the trial balance against the closing
   figures from the old system. A cutover that does not balance is a cutover that has already
   failed.
4. Enter the statutory tables, with their sources, and have them approved by a second person.
5. Enter the requirement rules, with their authorities, and have them approved by the named
   reviewer.
6. Open the live matters. Their documents go into the library, which means they go through
   quarantine — so either the scanner is configured by now, or somebody releases each one
   deliberately and the record says so.
7. Take a backup. Verify it. Only then let anybody rely on the platform.
8. Keep the old system readable for a stated period. Not writable — readable. Every cutover
   produces a question that only the old records answer.
