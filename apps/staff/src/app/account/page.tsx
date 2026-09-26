import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import { getMfaStatus, getSetting } from "@cac/core";
import { requirePrincipal } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, Panel, Td } from "@/components/ui";
import { MfaEnrolment, PasswordForm, SessionRevoke } from "./AccountForms";

type SessionRow = {
  id: string;
  ip: string | null;
  user_agent: string | null;
  created_at: Date | string;
  last_seen_at: Date | string;
};

/**
 * My account.
 *
 * Password, authenticator, sessions, and an honest list of what this account can
 * do. The session list is here because seeing an unfamiliar device is how people
 * notice a compromise, and ending it themselves is faster than finding an
 * administrator.
 */
export default async function AccountPage() {
  const principal = await requirePrincipal();
  const db = await getDb();

  const [sessions, mfa, minLength, user] = await Promise.all([
    db.execute<SessionRow>(sql`
      SELECT id, host(ip) AS ip, user_agent, created_at, last_seen_at
        FROM auth.session
       WHERE user_id = ${principal.userId} AND revoked_at IS NULL AND expires_at > now()
       ORDER BY last_seen_at DESC
    `),
    getMfaStatus(db, principal),
    getSetting<number>(db, "security.password_min_length", 12),
    db.execute<{ must_change_password: boolean }>(
      sql`SELECT must_change_password FROM auth."user" WHERE id = ${principal.userId}`,
    ),
  ]);

  const mustChange = user.rows?.[0]?.must_change_password ?? false;
  const capabilities = [...principal.capabilities].sort();
  const byDomain = new Map<string, string[]>();
  for (const capability of capabilities) {
    const domain = capability.split(".")[0] ?? "other";
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), capability]);
  }

  return (
    <Shell principal={principal} title="My account" breadcrumbs={[{ label: "My account" }]}>
      <div className="space-y-4">
        {principal.mfaRequired && !mfa.enrolled && (
          <Alert tone={principal.mustEnrolMfa ? "danger" : "warn"}>
            {principal.mustEnrolMfa ? (
              <>
                <strong>This account requires an authenticator and has none.</strong> The period for
                setting one up has passed, so nothing else in the platform opens until you do. It
                takes about a minute: the panel below shows a QR code for any authenticator app.
              </>
            ) : (
              <>
                <strong>This account needs an authenticator.</strong> Set one up by{" "}
                {principal.mfaEnrolmentDueAt
                  ? new Date(principal.mfaEnrolmentDueAt).toLocaleDateString("en-GB", {
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                    })
                  : "the deadline"}
                . You can carry on working until then; after that date this is the only page that
                opens. It takes about a minute — the panel below shows a QR code.
              </>
            )}
          </Alert>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Profile">
            <dl className="space-y-2 text-[13px]">
              <Row label="Name">{principal.fullName}</Row>
              <Row label="Email">
                <span className="font-mono text-[12px]">{principal.email}</span>
              </Row>
              <Row label="Roles">
                {principal.roles.map((role) => role.replace(/_/g, " ")).join(", ") || "None"}
              </Row>
              <Row label="Two-step verification">
                {mfa.enrolled ? (
                  <Badge tone="ok">Enrolled</Badge>
                ) : (
                  <Badge tone="warn">Not set up</Badge>
                )}
              </Row>
              {mfa.enrolled && (
                <>
                  <Row label="Device">{mfa.label}</Row>
                  <Row label="Recovery codes left">
                    {mfa.recoveryCodesRemaining === 0 ? (
                      <span className="text-[var(--color-warn)]">none</span>
                    ) : (
                      mfa.recoveryCodesRemaining
                    )}
                  </Row>
                </>
              )}
            </dl>
          </Panel>

          <Panel title="Change password">
            <PasswordForm minLength={minLength} mustChange={mustChange} />
          </Panel>
        </div>

        <Panel
          title="Authenticator app"
          description={
            mfa.enrolled
              ? "Enrolled. Replacing it needs an administrator to remove the current device first, and that removal is recorded."
              : "A six-digit code that changes every 30 seconds, generated on your phone."
          }
        >
          {mfa.enrolled ? (
            <p className="text-[12px] text-[var(--color-muted)]">
              Last used{" "}
              {mfa.lastUsedAt ? new Date(mfa.lastUsedAt).toLocaleString("en-GB") : "never"}. If you
              have lost the device, use a recovery code to sign in, or ask an administrator to remove
              it so you can enrol a new one.
            </p>
          ) : (
            <MfaEnrolment />
          )}
        </Panel>

        <Panel
          title="Signed-in devices"
          description="Sessions are server-side and can be ended from here. Anything you do not recognise should be ended and reported."
        >
          <DataTable
            columns={["Device", "Address", "Started", "Last active", ""]}
            caption="Active sessions"
          >
            {(sessions.rows ?? []).map((session) => (
              <tr key={session.id}>
                <Td>
                  <span className="text-[12px]">{shortenAgent(session.user_agent)}</span>
                </Td>
                <Td>
                  <span className="font-mono text-[11px]">{session.ip ?? "unknown"}</span>
                </Td>
                <Td>{new Date(session.created_at).toLocaleString("en-GB")}</Td>
                <Td>{new Date(session.last_seen_at).toLocaleString("en-GB")}</Td>
                <Td>
                  <SessionRevoke sessionId={session.id} isCurrent={session.id === principal.sessionId} />
                </Td>
              </tr>
            ))}
          </DataTable>
        </Panel>

        <Panel
          title={`What this account can do (${capabilities.length})`}
          description="The capabilities the server checks. Shown in full rather than summarised, so there is no gap between what you believe you can do and what you can."
        >
          {capabilities.length === 0 ? (
            <p className="text-[12px] text-[var(--color-muted)]">
              Nothing beyond signing in and reading this page. An administrator assigns roles.
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[...byDomain.entries()].map(([domain, list]) => (
                <div key={domain}>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-faint)]">
                    {domain} ({list.length})
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {list.map((capability) => (
                      <li key={capability} className="font-mono text-[11px]">
                        {capability}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </Shell>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

/**
 * A user agent trimmed to the part a person recognises.
 *
 * Full UA strings are unreadable, and the point of this column is "is that me?".
 */
function shortenAgent(agent: string | null): string {
  if (!agent) return "Unknown device";
  const browser = /(Edg|OPR|Chrome|Firefox|Safari)\/[\d.]+/.exec(agent)?.[1];
  const platform = /\((?:([^;)]+)[;)])/.exec(agent)?.[1]?.trim();
  const names: Record<string, string> = { Edg: "Edge", OPR: "Opera" };
  if (!browser) return agent.slice(0, 60);
  return `${names[browser] ?? browser}${platform ? ` on ${platform}` : ""}`;
}
