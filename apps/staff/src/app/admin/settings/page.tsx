import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, Panel, Td } from "@/components/ui";
import { SettingForm } from "./SettingForm";

type SettingRow = {
  key: string;
  value: unknown;
  category: string;
  label: string;
  description: string | null;
  needs_review: boolean;
  requires_approval: boolean;
};

export default async function SettingsPage() {
  const principal = await requireCapability("admin.settings.manage");
  const db = await getDb();

  const settings = await db.execute<SettingRow>(sql`
    SELECT key, value, category, label, description, needs_review, requires_approval
    FROM org.setting ORDER BY category, key
  `);

  const rows = settings.rows ?? [];
  const unconfirmed = rows.filter((row) => row.needs_review);
  const byCategory = new Map<string, SettingRow[]>();
  for (const row of rows) {
    const list = byCategory.get(row.category) ?? [];
    list.push(row);
    byCategory.set(row.category, list);
  }

  return (
    <Shell
      principal={principal}
      title="Settings"
      breadcrumbs={[{ label: "Administration" }, { label: "Settings" }]}
    >
      <div className="space-y-4">
        {unconfirmed.length > 0 && (
          <Alert tone="warn">
            <strong>
              {unconfirmed.length} setting{unconfirmed.length === 1 ? " has" : "s have"} not been
              confirmed.
            </strong>{" "}
            Several are deliberately unset rather than guessed: an overtime multiplier or a tax rate
            that looks plausible and is wrong appears on a payslip or an invoice as though it were
            checked. Features that depend on them stay switched off until somebody confirms the real
            value here. See docs/OPEN_QUESTIONS.md.
          </Alert>
        )}

        {[...byCategory.entries()].map(([category, items]) => (
          <Panel key={category} title={category.toUpperCase()}>
            <DataTable columns={["Setting", "Value", "Status"]} caption={`${category} settings`}>
              {items.map((s) => (
                <tr key={s.key}>
                  <Td>
                    <p className="font-medium">{s.label}</p>
                    <p className="font-mono text-[11px] text-[var(--color-faint)]">{s.key}</p>
                    {s.description && (
                      <p className="mt-1 max-w-xl text-[12px] text-[var(--color-muted)]">
                        {s.description}
                      </p>
                    )}
                  </Td>
                  <Td>
                    <SettingForm
                      settingKey={s.key}
                      value={s.value}
                      requiresApproval={s.requires_approval}
                      needsReview={s.needs_review}
                    />
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {s.needs_review && <Badge tone="warn">Unconfirmed</Badge>}
                      {s.requires_approval && <Badge tone="info">Approval required</Badge>}
                      {!s.needs_review && !s.requires_approval && <Badge tone="ok">Set</Badge>}
                    </div>
                  </Td>
                </tr>
              ))}
            </DataTable>
          </Panel>
        ))}
      </div>
    </Shell>
  );
}
