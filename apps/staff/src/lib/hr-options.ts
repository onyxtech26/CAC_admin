import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import { listDepartments, listEmployees, listPositions, listWorkSchedules } from "@cac/core";

/**
 * The reference data every HR form needs.
 *
 * One call rather than each page assembling its own set and drifting from the
 * others — the same arrangement as `accounting-options.ts`, and for the same
 * reason.
 */
export async function hrFormOptions(options: { excludeEmployeeId?: string } = {}) {
  const db = await getDb();

  const [departments, positions, schedules, employees, centres] = await Promise.all([
    listDepartments(db),
    listPositions(db),
    listWorkSchedules(db),
    listEmployees(db, { limit: 1000 }),
    db.execute<{ id: string; code: string; name: string }>(
      sql`SELECT id, code, name FROM org.cost_centre WHERE is_active ORDER BY code`,
    ),
  ]);

  return {
    departments: departments.map((row) => ({ id: row.id, code: row.code, name: row.name })),
    positions: positions.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.title,
      departmentId: row.departmentId,
    })),
    schedules: schedules.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      isDefault: row.isDefault,
      summary: `${row.startsAt}–${row.endsAt}, ${row.workDays.length} days`,
    })),
    // Somebody cannot report to themselves, and offering them the option only
    // invites the trigger to refuse it afterwards.
    managers: employees
      .filter((row) => row.id !== options.excludeEmployeeId)
      .map((row) => ({ id: row.id, code: row.employeeNo, name: row.fullName })),
    costCentres: centres.rows ?? [],
  };
}
