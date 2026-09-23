import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Badge, DataTable, Panel, Td } from "@/components/ui";

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
                    <code className="font-mono text-[12px]">
                      {s.value === null ? "unset" : JSON.stringify(s.value)}
                    </code>
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
