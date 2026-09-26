import { getDb } from "@cac/db";
import { listEnquiries, type EnquiryStatus } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, Panel, StatTile, Td } from "@/components/ui";
import { EnquiryHandling } from "./EnquiryForms";

const TONE = {
  new: "warn",
  in_progress: "info",
  answered: "ok",
  converted: "ok",
  spam: "neutral",
  closed: "neutral",
} as const;

const LABEL: Record<EnquiryStatus, string> = {
  new: "new",
  in_progress: "being answered",
  answered: "answered",
  converted: "became business",
  spam: "spam",
  closed: "closed",
};

/**
 * What the website's enquiry form produced.
 *
 * The other end of the form. An enquiry is a record rather than an email because an email is
 * somebody's inbox: this can be assigned, answered, counted, and linked to the customer and the
 * matter it became.
 *
 * Everything on this page is text a stranger typed. React escapes it, which is what stops a message
 * containing markup from becoming markup — and nothing here renders it any other way.
 */
export default async function EnquiriesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const principal = await requireCapability("crm.enquiry.view");
  const query = await searchParams;
  const db = await getDb();

  const status = (query.status as EnquiryStatus | undefined) ?? undefined;
  const enquiries = await listEnquiries(db, principal, { status, limit: 200 });
  const all = status ? await listEnquiries(db, principal, { limit: 200 }) : enquiries;

  const counts = {
    waiting: all.filter((row) => row.status === "new").length,
    inProgress: all.filter((row) => row.status === "in_progress").length,
    converted: all.filter((row) => row.status === "converted").length,
  };

  const canManage = principal.capabilities.has("crm.enquiry.manage");

  return (
    <Shell
      principal={principal}
      title="Enquiries"
      breadcrumbs={[{ label: "Enquiries" }]}
    >
      <div className="space-y-4">
        <Alert tone="info">
          Enquiries from the website&rsquo;s contact form. The platform does not reply for you —
          there is no mail transport configured and a form that promised one would be promising
          something that does not happen. The address and phone number the enquirer left are here;
          answering is a person&rsquo;s job, and recording that it was answered is what this screen is
          for.
        </Alert>

        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile
            label="Waiting"
            value={String(counts.waiting)}
            tone={counts.waiting > 0 ? "warn" : "neutral"}
            hint={counts.waiting > 0 ? "nobody has picked these up" : "nothing outstanding"}
          />
          <StatTile label="Being answered" value={String(counts.inProgress)} />
          <StatTile label="Became business" value={String(counts.converted)} />
        </div>

        <Panel title="Filter">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="status" className="block text-[12px] font-medium">
                Status
              </label>
              <select
                id="status"
                name="status"
                defaultValue={status ?? ""}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
              >
                <option value="">All</option>
                {(Object.keys(LABEL) as EnquiryStatus[]).map((value) => (
                  <option key={value} value={value}>
                    {LABEL[value]}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px]"
            >
              Show
            </button>
          </form>
        </Panel>

        <Panel title={`${enquiries.length} enquir${enquiries.length === 1 ? "y" : "ies"}`}>
          {enquiries.length === 0 ? (
            <EmptyState
              title="Nothing here"
              body="Enquiries from the website's contact form arrive on this screen."
            />
          ) : (
            <DataTable
              columns={["Reference", "Who", "About", "Received", "Status", ""]}
              caption="Enquiries"
            >
              {enquiries.map((enquiry) => (
                <tr key={enquiry.id} className="align-top">
                  <Td>
                    <span className="font-mono text-[12px]">{enquiry.reference}</span>
                  </Td>
                  <Td>
                    <strong>{enquiry.name}</strong>
                    {enquiry.company && (
                      <span className="block text-[11px] text-[var(--color-muted)]">
                        {enquiry.company}
                      </span>
                    )}
                    {enquiry.email && (
                      <a
                        href={`mailto:${enquiry.email}`}
                        className="block text-[11px] underline"
                      >
                        {enquiry.email}
                      </a>
                    )}
                    {enquiry.phone && (
                      <a href={`tel:${enquiry.phone}`} className="block text-[11px] underline">
                        {enquiry.phone}
                      </a>
                    )}
                  </Td>
                  <Td>
                    {enquiry.service && (
                      <span className="block text-[11px] font-semibold">{enquiry.service}</span>
                    )}
                    <span className="block max-w-md whitespace-pre-wrap text-[12px]">
                      {enquiry.message}
                    </span>
                    {enquiry.handlingNote && (
                      <span className="mt-1 block text-[11px] text-[var(--color-muted)]">
                        Handling: {enquiry.handlingNote}
                        {enquiry.handledByName ? ` — ${enquiry.handledByName}` : ""}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <span className="text-[12px]">
                      {new Date(enquiry.createdAt).toLocaleString("en-GB")}
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={TONE[enquiry.status]}>{LABEL[enquiry.status]}</Badge>
                  </Td>
                  <Td>
                    {canManage ? (
                      <EnquiryHandling enquiryId={enquiry.id} status={enquiry.status} />
                    ) : (
                      <span className="text-[11px] text-[var(--color-faint)]">—</span>
                    )}
                  </Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Panel>
      </div>
    </Shell>
  );
}
