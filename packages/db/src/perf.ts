import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "./schema/index.js";
import { runMigrations } from "./migrate.js";
import { seed } from "./seed.js";

/**
 * A performance probe, run against a synthetic dataset.
 *
 *   pnpm --filter @cac/db perf
 *
 * The point is not a benchmark number — it is the shape of the curve, and finding the query that
 * is accidentally quadratic before CAC does. Every figure it prints is measured on this machine
 * against PGlite, which is PostgreSQL compiled to WebAssembly: slower than a real server by a
 * constant factor, and useful precisely because of that. A query that is comfortable here is
 * comfortable anywhere; one that is slow here is worth looking at before it reaches a server that
 * hides it.
 *
 * What is deliberately *not* claimed: that these numbers predict production. They do not. Q-INFRA-1
 * has not been answered, so there is no production to predict.
 */

const SCALE = Number(process.env.CAC_PERF_SCALE ?? "1");

interface Timing {
  what: string;
  rows: number;
  ms: number;
  /** Null for a one-off. Set for a query measured twice; see `measure`. */
  firstMs: number | null;
}

async function time<T>(what: string, fn: () => Promise<T>): Promise<{ result: T; timing: Timing }> {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  const rows = Array.isArray((result as { rows?: unknown[] })?.rows)
    ? (result as { rows: unknown[] }).rows.length
    : 0;
  return { result, timing: { what, rows, ms, firstMs: null } };
}

/**
 * Times a read twice and reports the repeat.
 *
 * The first execution of a query pays for parsing, planning and pulling the index pages off disk,
 * and on a GIN index over twenty thousand rows that dominates: the first full-text search measured
 * 197 ms and the second 11 ms, which is the difference between a cold cache and a query worth
 * worrying about. Reporting only the first would invent a performance problem; reporting only the
 * repeat would hide a genuinely expensive plan. So both are printed, and the repeat is the one to
 * read.
 */
async function measure<T>(what: string, fn: () => Promise<T>): Promise<Timing> {
  const first = await time(what, fn);
  const again = await time(what, fn);
  return { ...again.timing, firstMs: first.timing.ms };
}

async function main(): Promise<void> {
  const pglite = new PGlite();
  await pglite.waitReady;
  const db = drizzlePglite(pglite, { schema });

  const timings: Timing[] = [];
  const record = (timing: Timing) => {
    timings.push(timing);
    const repeat = `${timing.ms.toFixed(1).padStart(8)} ms`;
    const cold = timing.firstMs === null ? "" : `  (first run ${timing.firstMs.toFixed(0)} ms)`;
    console.log(`  ${timing.what.padEnd(48)} ${repeat}  ${timing.rows} row(s)${cold}`);
  };

  console.log("Setting up…");
  (await time("migrate", () => runMigrations(db))).timing;
  (await time("seed", () => seed(db))).timing;

  // ---- Synthetic data -----------------------------------------------------
  // Written with generate_series rather than through the application, because the point is to
  // measure the queries the screens run, not the cost of the write paths — those are covered by
  // the tests, one transaction at a time, which is how they are actually used.
  const cases = 400 * SCALE;
  const documentsPerCase = 4;
  const chunksPerDocument = 12;

  console.log(`\nBuilding a synthetic dataset (scale ${SCALE})…`);

  const user = await db.execute<{ id: string }>(sql`
    INSERT INTO auth."user" (email, password_hash, full_name)
    VALUES ('perf@cac.test', 'x', 'Perf probe') RETURNING id
  `);
  const userId = user.rows![0].id;

  const employee = await db.execute<{ id: string }>(sql`
    INSERT INTO hr.employee (employee_no, full_name, joined_on, basic_salary, created_by)
    VALUES ('EMP-PERF', 'Perf probe', '2024-01-01', 0, ${userId}) RETURNING id
  `);
  const employeeId = employee.rows![0].id;

  await time("insert cases", () =>
    db.execute(sql`
      INSERT INTO estate.case (case_no, matter_type, title, deceased_name, opened_on, created_by)
      SELECT 'CASE-PERF-' || lpad(i::text, 6, '0'),
             (ARRAY['probate','letters_of_administration','valuation'])[1 + (i % 3)],
             'Synthetic matter ' || i,
             'Deceased ' || i,
             DATE '2026-01-01' + (i % 200),
             ${userId}
        FROM generate_series(1, ${cases}) AS i
    `),
  ).then(({ timing }) => record(timing));

  await time("assign every case to one employee", () =>
    db.execute(sql`
      INSERT INTO estate.case_assignment (case_id, employee_id, role, assigned_by)
      SELECT id, ${employeeId}, 'lead', ${userId} FROM estate.case
    `),
  ).then(({ timing }) => record(timing));

  await time("insert assets", () =>
    db.execute(sql`
      INSERT INTO estate.case_asset
        (case_id, category, description, valuation_amount, valuation_basis, valuation_date,
         valuation_source, created_by)
      SELECT c.id, 'land', 'Asset ' || g, 100000 + g, 'Synthetic', DATE '2026-05-01',
             'Synthetic source', ${userId}
        FROM estate.case c CROSS JOIN generate_series(1, 5) AS g
    `),
  ).then(({ timing }) => record(timing));

  await time("insert library documents", () =>
    db.execute(sql`
      INSERT INTO library.document
        (document_no, title, original_filename, media_type, byte_size, sha256, case_id,
         scan_status, scanner, scanned_at, extraction_status, extraction_method, page_count,
         text_chars, extracted_at, created_by)
      SELECT 'DOC-PERF-' || lpad((row_number() OVER ())::text, 7, '0'),
             'Synthetic document ' || g, 'file.txt', 'text/plain', 1024,
             md5(c.id::text || g::text) || md5(g::text), c.id,
             'clean', 'internal:perf', now(), 'extracted', 'plain_text', 1, 4000, now(),
             ${userId}
        FROM estate.case c CROSS JOIN generate_series(1, ${documentsPerCase}) AS g
    `),
  ).then(({ timing }) => record(timing));

  await time("insert chunks (the search index)", () =>
    db.execute(sql`
      INSERT INTO library.chunk
        (document_id, ordinal, text, page_from, page_to, char_from, char_to, token_estimate,
         method, confidence)
      SELECT d.id, g,
             -- Varied on purpose. Identical text in every passage would make a query match the
             -- whole corpus, and the probe would then be measuring how long it takes to rank
             -- twenty thousand rows rather than how long a search takes.
             CASE g % 4
               WHEN 0 THEN 'The estate of the deceased includes land at Taman Perf. Reference '
               WHEN 1 THEN 'Harta pusaka termasuk sebidang tanah di Taman Perf. Rujukan '
               WHEN 2 THEN 'A bank account and some shares were reported by the executor. Reference '
               ELSE 'Correspondence with the registry about the grant. Reference '
             END || d.document_no || ' passage ' || g,
             1, 1, (g - 1) * 1000, g * 1000, 250, 'plain_text', 1
        FROM library.document d CROSS JOIN generate_series(1, ${chunksPerDocument}) AS g
    `),
  ).then(({ timing }) => record(timing));

  await db.execute(sql`
    UPDATE library.document SET chunk_count = ${chunksPerDocument}, indexed_at = now()
  `);

  const totals = await db.execute<{ cases: string; documents: string; chunks: string; assets: string }>(sql`
    SELECT (SELECT count(*) FROM estate.case)::text AS cases,
           (SELECT count(*) FROM library.document)::text AS documents,
           (SELECT count(*) FROM library.chunk)::text AS chunks,
           (SELECT count(*) FROM estate.case_asset)::text AS assets
  `);
  const size = totals.rows![0];
  console.log(
    `\n${size.cases} cases, ${size.assets} assets, ${size.documents} documents, ${size.chunks} indexed passages.`,
  );

  // ---- The queries the screens actually run -------------------------------
  // Without this the planner is working from defaults, and a plan chosen on guessed statistics
  // is not the plan production would choose.
  await db.execute(sql`ANALYZE`);

  console.log("\nThe queries the screens run (repeat run; the first is shown beside it):");

  record(
    await measure("case list with counts (the /cases query)", () =>
    db.execute(sql`
      SELECT c.id, c.case_no, c.title,
             (SELECT count(*) FROM estate.case_requirement r
               WHERE r.case_id = c.id AND r.status IN ('outstanding','in_progress')) AS outstanding,
             (SELECT count(*) FROM estate.case_task t
               WHERE t.case_id = c.id AND t.status IN ('open','in_progress','blocked')) AS open_tasks
        FROM estate.case c
       WHERE EXISTS (SELECT 1 FROM estate.case_assignment a
                      WHERE a.case_id = c.id AND a.employee_id = ${employeeId}
                        AND a.removed_at IS NULL)
       ORDER BY c.opened_on DESC LIMIT 200
    `),
    ),
  );

  record(
    await measure("estate position for one matter", () =>
    db.execute(sql`
      SELECT sum(valuation_amount) FROM estate.case_asset
       WHERE case_id = (SELECT id FROM estate.case LIMIT 1) AND status <> 'excluded'
    `),
    ),
  );

  record(
    await measure("full-text search, English, permission-filtered", () =>
    db.execute(sql`
      WITH q AS (SELECT plainto_tsquery('english', 'estate land') AS en)
      SELECT c.id, ts_rank_cd(c.tsv_en, q.en) AS score
        FROM library.chunk c
        JOIN library.document d ON d.id = c.document_id
        CROSS JOIN q
       WHERE c.tsv_en @@ q.en AND d.scan_status = 'clean'
         AND EXISTS (SELECT 1 FROM estate.case_assignment a
                      WHERE a.case_id = d.case_id AND a.employee_id = ${employeeId}
                        AND a.removed_at IS NULL)
       ORDER BY score DESC LIMIT 25
    `),
    ),
  );

  // The worst case worth knowing about: a term that appears in every passage. The index finds
  // everything, so the cost becomes ranking the whole corpus rather than searching it. Nothing is
  // wrong with the plan; it is what ranked full-text search costs when a query is not selective,
  // and it is the number to watch as the library grows.
  record(
    await measure("full-text search, a term matching everything", () =>
      db.execute(sql`
      WITH q AS (SELECT plainto_tsquery('english', 'reference') AS en)
      SELECT c.id, ts_rank_cd(c.tsv_en, q.en) AS score
        FROM library.chunk c
        JOIN library.document d ON d.id = c.document_id
        CROSS JOIN q
       WHERE c.tsv_en @@ q.en AND d.scan_status = 'clean'
       ORDER BY score DESC LIMIT 25
    `),
    ),
  );

  record(
    await measure("full-text search, simple (the Malay path)", () =>
    db.execute(sql`
      WITH q AS (SELECT plainto_tsquery('simple', 'harta pusaka tanah') AS s)
      SELECT c.id FROM library.chunk c CROSS JOIN q
       WHERE c.tsv_simple @@ q.s LIMIT 25
    `),
    ),
  );

  record(
    await measure("audit trail, newest first", () =>
    db.execute(sql`
      SELECT id, action, entity_type, created_at FROM audit.event
       ORDER BY created_at DESC LIMIT 100
    `),
    ),
  );

  record(
    await measure("trial balance", () =>
    db.execute(sql`
      SELECT a.code, a.name, sum(l.debit) AS debit, sum(l.credit) AS credit
        FROM accounting.account a
        LEFT JOIN accounting.journal_line l ON l.account_id = a.id
       GROUP BY a.code, a.name ORDER BY a.code
    `),
    ),
  );

  // ---- The plan, when asked for ------------------------------------------
  // CAC_PERF_EXPLAIN=1 prints the plan for the one query that is not trivially fast, so the
  // probe can say *why* rather than only how long. A stopwatch that cannot explain itself sends
  // somebody guessing.
  if (process.env.CAC_PERF_EXPLAIN === "1") {
    console.log("\nPlan for the English full-text search:");
    const plan = await db.execute<Record<string, string>>(sql`
      EXPLAIN (ANALYZE, BUFFERS)
      WITH q AS (SELECT plainto_tsquery('english', 'estate land bank') AS en)
      SELECT c.id, ts_rank_cd(c.tsv_en, q.en) AS score
        FROM library.chunk c
        JOIN library.document d ON d.id = c.document_id
        CROSS JOIN q
       WHERE c.tsv_en @@ q.en AND d.scan_status = 'clean'
         AND EXISTS (SELECT 1 FROM estate.case_assignment a
                      WHERE a.case_id = d.case_id AND a.employee_id = ${employeeId}
                        AND a.removed_at IS NULL)
       ORDER BY score DESC LIMIT 25
    `);
    for (const row of plan.rows ?? []) console.log(`  ${Object.values(row)[0]}`);
  }

  // ---- The verdict --------------------------------------------------------
  const slow = timings.filter((timing) => timing.ms > 250);
  console.log("\n" + "-".repeat(78));
  if (slow.length === 0) {
    console.log("Nothing took longer than 250 ms on this dataset.");
  } else {
    console.log("Worth looking at:");
    for (const timing of slow) console.log(`  ${timing.what} — ${timing.ms.toFixed(0)} ms`);
  }
  console.log(
    "\nMeasured against PGlite (PostgreSQL in WebAssembly), which is slower than a real server by\n" +
      "a constant factor. These figures are for finding the query that is accidentally quadratic,\n" +
      "not for predicting production — there is no production to predict until Q-INFRA-1 is answered.",
  );

  await pglite.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
