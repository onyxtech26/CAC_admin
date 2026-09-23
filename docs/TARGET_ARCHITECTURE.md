# CAC — Target Architecture

Companion to `CURRENT_ARCHITECTURE.md`. Decisions here are **proposals pending sign-off**
on the items in `OPEN_QUESTIONS.md`.

---

## 1. Shape

Two applications, one repository, shared brand tokens.

```
conglomerate4u.com              staff.conglomerate4u.com
        │                                 │
   public website                  internal platform
   (Vite SPA, unchanged)           (Next.js, server-rendered)
        │                                 │
        └── double-click HOME ────────────┘
                 (convenience only)
                                          │
                        ┌─────────────────┼─────────────────┐
                        │                 │                 │
                   PostgreSQL        Object storage      Job queue
                   + pgvector        (private, S3-compat) (OCR/AI/imports)
```

### Why two apps and not one

The brief says don't rewrite working software. The public site has **no server-side code
to extend** — there is literally nothing shared to build on. Folding an ERP into a static
marketing SPA would mean rewriting the SPA into a server framework first, putting a
signed-off production site at risk to gain nothing.

Keeping them separate also gives a **hard security boundary**: the public site never
receives a session cookie, never talks to the database, and a defect in marketing copy
can never expose case data.

### Why a subdomain, not a path

`staff.conglomerate4u.com` rather than `conglomerate4u.com/staff`:

- **Cookie isolation.** Session cookies scope to the staff host and are never transmitted
  to the public site or any third-party script on it.
- **No cross-project rewrite fragility.** Vercel path-rewrites between two projects add a
  failure mode with no compensating benefit.
- **Independent deploys.** Marketing copy changes cannot take the ERP down, and vice versa.
- **Clean CSP.** The two apps need very different policies.

Cost: the double-click gesture becomes a cross-origin navigation. That is fine — it is a
plain link, and **security must never depend on it** (see §4).

## 2. Monorepo layout

```
/
├── apps/
│   ├── web/                 existing Vite public site — MOVED, not rewritten
│   └── staff/               NEW — Next.js App Router internal platform
├── packages/
│   ├── brand/               shared design tokens (navy/gold ramps, type scale)
│   ├── db/                  schema, migrations, typed client
│   ├── core/                domain logic: accounting, payroll, attendance, case rules
│   ├── ai/                  provider abstraction, RAG, prompt assembly
│   └── contracts/           Zod schemas shared by client + server
└── docs/
```

Moving `web/` is a path change only — no code edits, no behaviour change, and the Vercel
project root directory is repointed. Verified by rebuilding and diffing the output.

**Package manager:** migrate npm → **pnpm** workspaces. Justification: workspace support,
strict peer resolution, far smaller `node_modules` across 6 packages. One-time cost.

## 3. Stack for the internal app

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js (App Router) + TypeScript** | Server components, route handlers, middleware for auth, streaming. Same React 19 the team already writes. |
| Data access | **Drizzle ORM** + `drizzle-kit` migrations | SQL-first, typed, migrations are reviewable SQL — important for an audited accounting schema. Prisma is acceptable; Drizzle wins on explicit SQL and no separate engine binary. |
| Database | **PostgreSQL 16+** | Non-negotiable: transactions, `NUMERIC`, row-level constraints, `pgvector`, full-text search. |
| Validation | **Zod** at every boundary | One schema reused for client form, server action and DB insert. |
| Auth | **Auth.js v5**, credentials + TOTP, DB sessions | See `SECURITY_MODEL.md`. App-owned so RBAC, audit and session revocation live in our schema. |
| Object storage | **S3-compatible, private buckets only** | Never public. Access via short-lived signed URLs. |
| Jobs | **Queue-backed workers** (pg-boss on the same Postgres, or Redis+BullMQ if volume demands) | OCR, Excel imports, embeddings, AI runs, report generation must never block a request. |
| Search | **Postgres `tsvector` + `pgvector`**, hybrid | No extra infrastructure until proven necessary. |
| PDF/DOCX | Server-side renderer + `docx` templating | Staff need editable DOCX first, PDF on finalisation. |
| AI | **Provider abstraction** (`packages/ai`) | Never couple business logic to one vendor. |

**Deliberately deferred:** Redis, Elasticsearch, a separate API service, microservices,
event sourcing. None is justified at CAC's size. Revisit with evidence.

## 4. The HOME double-click gesture

Requirement: double-clicking **HOME** in the public nav opens staff login. Single click
must keep navigating home.

```
onClick      → schedule normal navigation after ~250 ms
onDoubleClick → cancel it, open https://staff.conglomerate4u.com/login
touch        → equivalent double-tap within the same window
```

`prefers-reduced-motion` and keyboard users are unaffected; the gesture is additive and
the nav item keeps its normal semantics and href.

> **This is a convenience shortcut and nothing more.**
> `staff.conglomerate4u.com` is a fully public URL. Anyone can find it. Every route behind
> it is protected server-side by session + RBAC checks that run *before* any data is read.
> Discovering the URL yields a login form and nothing else. Security never depends on the
> gesture being secret.

## 5. Request lifecycle — every mutation, no exceptions

```
UI (optimistic-free)
 → Zod parse (client, UX only)
 → Server Action / Route Handler
     → authenticate  — valid, unexpired, unrevoked session
     → authorise     — capability check, not role check
     → Zod parse     — re-validate; client output is untrusted
     → business rules— recompute every total, tax, balance server-side
     → DB transaction— all-or-nothing
     → audit event   — same transaction as the change
     → invalidate caches
 → typed result
```

**Never trusted from the client:** user id, employee id, role, any monetary total, tax
amount, posting status, approval status, document ownership. All recomputed or re-read.

## 6. Money

- Storage: `NUMERIC(18,4)` — never `float`/`double`/`real`.
- Transport/compute: integer **minor units** (sen) or a decimal library. Never JS `number`
  arithmetic on money.
- Every monetary column carries an explicit `currency CHAR(3)`, default `MYR`.
- Rounding rules are configuration, applied at one choke point, unit-tested.

## 7. Accounting core

A real double-entry ledger, not invoice/expense tables with a report on top.

```
Source document (invoice, receipt, voucher, petty cash, payroll)
        │  approved
        ▼
   Posting engine      ── refuses if period closed
        │              ── refuses if SUM(debit) ≠ SUM(credit)
        ▼
  Journal + JournalLines   (immutable once posted)
        │
        ▼
 General Ledger → Trial Balance → P&L → Balance Sheet → Aging
```

Invariants enforced in the database, not only in code:

- `SUM(debit) = SUM(credit)` per journal — deferred constraint or posting-time check.
- A journal in a closed period cannot be inserted or altered.
- A posted journal is append-only. Corrections are **reversal entries**, never edits.
- Document numbers are gapless per sequence and never recycled.

Document states: `draft → submitted → approved → posted → (reversed)`.

## 8. AI / RAG

```
Case facts + staff question
   → query planner
   → retrieval, permission-filtered at the SQL layer
        ├── OFFICIAL_LAW / OFFICIAL_COURT      (high authority)
        ├── BAR / PROCEDURES                   (guidance)
        └── COMPANY_PRECEDENTS                 (examples, NOT law)
   → deterministic rule engine  ←── the rules live here, not in the model
   → LLM: structured JSON only, with citations
   → validation against schema
   → human review  ←── required before anything becomes APPROVED
```

Hard rules:

- **The rule engine decides requirements; the LLM assists.** Legal requirements are never
  determined by model output alone.
- Retrieved document text is **data, never instructions**. Prompt-injection defences and
  a strict prompt hierarchy — an uploaded PDF cannot redefine system behaviour.
- The model gets **narrow tools**, never database access. Every tool enforces the caller's
  permissions and writes an audit event.
- Precedents are labelled as precedent. A past internal file is never treated as law.
- No fine-tuning initially. RAG first. Revisit only for narrow formatting/classification.

## 9. Environments

| Env | Purpose | Data |
|---|---|---|
| Local | development | synthetic seed only |
| Staging | UAT, integration sandboxes (MyInvois sandbox) | synthetic only |
| Production | live | real — PDPA scope |

**Real client, employee or case data must never be copied into staging or local.**
Seed data is synthetic and labelled `DEMO`.

## 10. Migration approach

Strictly additive. The public site is not modified except for the nav gesture (one
component, one file) until the platform is live and stable.

1. Monorepo move — path change only, output diffed byte-for-byte.
2. CI gate — typecheck, lint, test, build. Fixes the 4 existing `TS6133` errors.
3. `apps/staff` scaffold, database, auth, RBAC, audit — nothing user-visible yet.
4. Modules per phase (`IMPLEMENTATION_PLAN.md`).
5. Public site gesture added **last**, once there is a login page worth reaching.

Rollback at every step: the public site is a separate Vercel project on its own deploy
history and can be rolled back independently.
