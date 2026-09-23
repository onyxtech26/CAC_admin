import Link from "next/link";
import { requirePrincipal } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Panel } from "@/components/ui";

export default async function DeniedPage({
  searchParams,
}: {
  searchParams: Promise<{ capability?: string }>;
}) {
  const principal = await requirePrincipal();
  const { capability } = await searchParams;

  return (
    <Shell principal={principal} title="Not permitted" breadcrumbs={[{ label: "Not permitted" }]}>
      <Panel>
        <Alert tone="danger">
          You do not have permission to open that page.
        </Alert>
        {capability && (
          <p className="mt-3 text-[13px] text-[var(--color-muted)]">
            It requires the capability <code className="font-mono text-[12px]">{capability}</code>,
            which is not granted to your roles ({principal.roles.join(", ") || "none"}).
          </p>
        )}
        <p className="mt-3 text-[13px] text-[var(--color-muted)]">
          If you need this access, ask an administrator. The request has been recorded.
        </p>
        <p className="mt-4">
          <Link href="/" className="text-[13px] text-[var(--color-info)] underline">
            Back to the dashboard
          </Link>
        </p>
      </Panel>
    </Shell>
  );
}
