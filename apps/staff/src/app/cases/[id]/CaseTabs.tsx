import Link from "next/link";

/**
 * The five jobs on a matter.
 *
 * Separate pages rather than one long screen: intake, the checklist, the file, the
 * tasks and the history are different pieces of work, done by different people at
 * different times, and a single page holding all of them would be unusable on the one
 * hand and slow on the other.
 */
const TABS = [
  { key: "overview", label: "Overview", path: "" },
  { key: "intake", label: "Intake", path: "/intake" },
  { key: "checklist", label: "Checklist", path: "/checklist" },
  { key: "file", label: "The file", path: "/file" },
  { key: "agent", label: "Agent", path: "/agent" },
  { key: "timeline", label: "History", path: "/timeline" },
] as const;

export type CaseTab = (typeof TABS)[number]["key"];

export function CaseTabs({ caseId, active }: { caseId: string; active: CaseTab }) {
  return (
    <nav
      aria-label="Sections of this matter"
      className="flex flex-wrap gap-1 border-b border-[var(--color-line)] pb-2"
    >
      {TABS.map((tab) => {
        const current = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={`/cases/${caseId}${tab.path}`}
            aria-current={current ? "page" : undefined}
            className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition ${
              current
                ? "bg-[var(--color-navy)] text-white"
                : "text-[var(--color-muted)] hover:bg-[var(--color-canvas)]"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
