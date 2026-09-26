import Link from "next/link";
import { getDb } from "@cac/db";
import {
  assistantFromEnv,
  embeddingProviderFromEnv,
  ocrFromEnv,
  resolveProvider,
  scannerFromEnv,
} from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, Panel, StatTile } from "@/components/ui";

/**
 * The five things this platform talks to, and which of them exist.
 *
 * `admin.integration.manage` was granted to a role and checked nowhere — a line in the RBAC matrix
 * describing a screen that did not exist. This is that screen.
 *
 * Every one of these is **absent by design**: a seam that refuses rather than pretending. That is
 * the right behaviour and it has a cost — a deployment that silently lost its scanner
 * configuration looks exactly like one that never had any, and the failure is quiet in both cases.
 * This page is how the two are told apart, and it is deliberately the only place that says so in
 * one view: the same answer is in the health endpoint, which a machine reads, and this is the one a
 * person reads.
 *
 * Nothing here configures anything, which is why the capability is about *seeing* what is
 * configured. Credentials live in the server environment rather than the database, so changing one
 * is a deployment change: a client secret in a settings table is a client secret in every backup
 * and visible to anyone who can read settings.
 */
export default async function IntegrationsPage() {
  const principal = await requireCapability("admin.integration.manage");
  const db = await getDb();

  const scanner = scannerFromEnv();
  const ocr = ocrFromEnv();
  const embedding = embeddingProviderFromEnv();
  const assistant = assistantFromEnv();
  const einvoice = await resolveProvider(db);

  const seams = [
    {
      name: "Malware scanning",
      configured: scanner.isConfigured(),
      provider: scanner.name,
      variables: ["CAC_CLAMAV_HOST", "CAC_CLAMAV_PORT"],
      whenAbsent:
        "An upload stays in quarantine until somebody with the authority releases it, with a " +
        "reason. Nothing is marked clean that nothing has looked at.",
      question: null,
    },
    {
      name: "Optical character recognition",
      configured: ocr.isConfigured(),
      provider: ocr.name,
      variables: ["CAC_OCR_ENDPOINT", "CAC_OCR_KEY"],
      whenAbsent:
        "A scanned PDF is held and is not searchable. The text is not guessed: an empty page and " +
        "a blank document are indistinguishable, and inventing the difference is how a document " +
        "is indexed as saying nothing.",
      question: null,
    },
    {
      name: "Embeddings",
      configured: embedding.isConfigured(),
      provider: embedding.name,
      variables: ["CAC_EMBEDDING_ENDPOINT", "CAC_EMBEDDING_MODEL"],
      whenAbsent:
        "Search is lexical, and says so on the results screen rather than implying it understood " +
        "the question.",
      question: null,
    },
    {
      name: "Assistant",
      configured: assistant.isConfigured(),
      provider: assistant.name,
      variables: ["CAC_ASSISTANT_ENDPOINT", "CAC_ASSISTANT_KEY"],
      whenAbsent:
        "The case agent is retrieval-only: it finds and cites, and does not compose. No case " +
        "content leaves the system.",
      question: "Q-AI-1",
    },
    {
      name: "MyInvois e-Invoicing",
      configured: einvoice.provider.configured,
      provider: einvoice.provider.name,
      variables: ["MYINVOIS_CLIENT_ID", "MYINVOIS_CLIENT_SECRET", "MYINVOIS_ENVIRONMENT"],
      whenAbsent:
        "Submission refuses and says what is missing. Nothing is recorded as submitted that was " +
        "not.",
      question: "Q-FIN-2",
    },
  ];

  const configured = seams.filter((seam) => seam.configured).length;

  return (
    <Shell
      principal={principal}
      title="Integrations"
      breadcrumbs={[{ label: "Administration" }, { label: "Integrations" }]}
    >
      <div className="space-y-4">
        <Alert tone="info">
          Each of these is absent by design and refuses rather than pretending. That is the right
          behaviour, and it means a deployment that lost its configuration looks like one that never
          had any — so this page exists to tell the two apart. Nothing is configured from here:
          credentials live in the server environment, because a secret in a settings table is a
          secret in every backup.
        </Alert>

        <div className="grid gap-3 sm:grid-cols-2">
          <StatTile
            label="Connected"
            value={`${configured} of ${seams.length}`}
            tone={configured === 0 ? "warn" : "neutral"}
          />
          <StatTile
            label="Environment"
            value={process.env.NODE_ENV ?? "unknown"}
            hint="what this server thinks it is"
          />
        </div>

        {seams.map((seam) => (
          <Panel key={seam.name} title={seam.name}>
            <div className="space-y-2 text-[13px]">
              <p>
                {seam.configured ? (
                  <Badge tone="ok">connected</Badge>
                ) : (
                  <Badge tone="warn">not configured</Badge>
                )}{" "}
                <span className="ml-1 text-[var(--color-muted)]">{seam.provider}</span>
              </p>

              <p className="text-[12px] text-[var(--color-muted)]">
                {seam.configured ? "While it is connected: " : "While it is absent: "}
                {seam.whenAbsent}
              </p>

              <p className="text-[12px] text-[var(--color-muted)]">
                Read from{" "}
                {seam.variables.map((variable, index) => (
                  <span key={variable}>
                    {index > 0 && ", "}
                    <span className="font-mono text-[11px]">{variable}</span>
                  </span>
                ))}
                .
                {seam.question && (
                  <>
                    {" "}
                    What is still needed of CAC is recorded as{" "}
                    <span className="font-mono text-[11px]">{seam.question}</span> in
                    docs/OPEN_QUESTIONS.md.
                  </>
                )}
              </p>

              {seam.name === "MyInvois e-Invoicing" && einvoice.blockers.length > 0 && (
                <ul className="mt-2 space-y-1 text-[12px] text-[var(--color-muted)]">
                  {einvoice.blockers.map((blocker, index) => (
                    <li key={index}>· {blocker}</li>
                  ))}
                </ul>
              )}
            </div>
          </Panel>
        ))}

        <p className="text-[11px] text-[var(--color-muted)]">
          The same answers are in{" "}
          <Link href="/api/health" className="text-[var(--color-info)] hover:underline">
            /api/health
          </Link>
          , which a monitoring system reads. This page is the one for a person.
        </p>
      </div>
    </Shell>
  );
}
