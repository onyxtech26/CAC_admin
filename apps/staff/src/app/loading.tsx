/**
 * Executive Skeleton Shell for Instant Zero-Delay Page Transitions.
 *
 * Rendered immediately by Next.js App Router (0ms) when navigating between
 * routes across the CAC Enterprise Platform, giving instant tactile feedback
 * with zero layout jump or perceived latency.
 */
export default function Loading() {
  return (
    <div className="min-h-screen bg-[var(--color-canvas)] lg:grid lg:grid-cols-[260px_1fr]">
      {/* Viewport-Pinned Executive Slate Rail Sidebar Skeleton */}
      <aside className="border-r border-slate-800 bg-[#0f172a] text-slate-300 lg:sticky lg:top-0 lg:h-screen lg:max-h-screen flex flex-col justify-between overflow-y-auto shrink-0">
        <div>
          {/* Brand Header Skeleton */}
          <div className="flex items-center gap-3 border-b border-slate-800/80 px-4 py-3.5">
            <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-900 border border-slate-700/80 p-1.5 shadow-xs">
              <img
                src="/assets/logo.webp"
                alt="CAC Logo"
                className="h-full w-full object-contain brightness-105 opacity-80"
              />
            </div>
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="h-3.5 w-32 rounded bg-slate-800 skeleton-shimmer-dark" />
              <div className="h-2.5 w-20 rounded bg-slate-850 skeleton-shimmer-dark" />
            </div>
          </div>

          {/* Active Suite Indicator Pill Skeleton */}
          <div className="px-3 pt-3 pb-1">
            <div className="h-8 w-full rounded-lg bg-slate-850/80 border border-slate-750 skeleton-shimmer-dark" />
          </div>

          {/* Nav List Skeletons */}
          <div className="px-3 py-3 space-y-5">
            <div className="space-y-1.5">
              <div className="h-2.5 w-20 rounded bg-slate-800/60 skeleton-shimmer-dark mb-2" />
              <div className="h-7 w-full rounded-lg bg-slate-800/50 skeleton-shimmer-dark" />
              <div className="h-7 w-full rounded-lg bg-slate-800/50 skeleton-shimmer-dark" />
              <div className="h-7 w-full rounded-lg bg-slate-800/50 skeleton-shimmer-dark" />
            </div>

            <div className="space-y-1.5">
              <div className="h-2.5 w-24 rounded bg-slate-800/60 skeleton-shimmer-dark mb-2" />
              <div className="h-7 w-full rounded-lg bg-slate-800/50 skeleton-shimmer-dark" />
              <div className="h-7 w-full rounded-lg bg-slate-800/50 skeleton-shimmer-dark" />
              <div className="h-7 w-full rounded-lg bg-slate-800/50 skeleton-shimmer-dark" />
              <div className="h-7 w-full rounded-lg bg-slate-800/50 skeleton-shimmer-dark" />
            </div>
          </div>
        </div>

        {/* Sidebar Footer Skeleton */}
        <div className="hidden lg:block shrink-0 border-t border-slate-800/80 px-4 py-3 bg-slate-950/40">
          <div className="flex items-center justify-between">
            <div className="h-3 w-28 rounded bg-slate-800 skeleton-shimmer-dark" />
            <div className="h-3 w-14 rounded bg-slate-800 skeleton-shimmer-dark" />
          </div>
        </div>
      </aside>

      {/* Main Workspace Skeleton */}
      <div className="flex min-w-0 flex-col bg-[var(--color-canvas)]">
        {/* Top Header Skeleton */}
        <header className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white/95 backdrop-blur-md px-6 py-3 shadow-2xs">
          <div className="flex items-center gap-2">
            <div className="h-4 w-12 rounded bg-slate-200 skeleton-shimmer" />
            <span className="text-slate-300">/</span>
            <div className="h-4 w-28 rounded bg-slate-200 skeleton-shimmer" />
          </div>

          <div className="flex items-center gap-3">
            <div className="h-7 w-24 rounded-lg bg-slate-100 skeleton-shimmer" />
            <div className="h-7 w-32 rounded-lg bg-slate-100 skeleton-shimmer hidden sm:block" />
            <div className="h-7 w-16 rounded-lg bg-slate-100 skeleton-shimmer" />
          </div>
        </header>

        {/* Tier 1: Suite Switcher Bar Skeleton */}
        <div className="border-b border-slate-200/90 bg-white px-6 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="h-7 w-28 rounded-lg bg-slate-100 skeleton-shimmer" />
            <div className="h-7 w-36 rounded-lg bg-slate-100 skeleton-shimmer" />
            <div className="h-7 w-32 rounded-lg bg-slate-100 skeleton-shimmer" />
            <div className="h-7 w-32 rounded-lg bg-slate-100 skeleton-shimmer" />
            <div className="h-7 w-28 rounded-lg bg-slate-100 skeleton-shimmer" />
          </div>
        </div>

        {/* Main Content Area Skeleton */}
        <main className="min-w-0 flex-1 p-6 lg:p-8 space-y-6">
          {/* Page Title & Actions Skeleton */}
          <div>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="h-8 w-56 rounded-md bg-slate-200 skeleton-shimmer" />
              <div className="flex items-center gap-2">
                <div className="h-8 w-24 rounded-lg bg-slate-200 skeleton-shimmer" />
                <div className="h-8 w-24 rounded-lg bg-slate-200 skeleton-shimmer" />
              </div>
            </div>
            <div className="hairline mt-3 h-px w-full bg-slate-200" aria-hidden="true" />
          </div>

          {/* 4 KPI Stat Tiles Skeleton */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs space-y-2.5"
              >
                <div className="h-3 w-24 rounded bg-slate-200 skeleton-shimmer" />
                <div className="h-7 w-28 rounded bg-slate-200 skeleton-shimmer" />
                <div className="h-3 w-36 rounded bg-slate-100 skeleton-shimmer" />
              </div>
            ))}
          </div>

          {/* Process Workflow Banner Skeleton */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs space-y-4">
            <div className="flex items-center justify-between">
              <div className="h-4 w-44 rounded bg-slate-200 skeleton-shimmer" />
              <div className="h-4 w-28 rounded bg-slate-100 skeleton-shimmer" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              {[1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className="rounded-lg border border-slate-200 bg-slate-50/60 p-3.5 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="h-5 w-5 rounded bg-slate-200 skeleton-shimmer" />
                    <div className="h-4 w-12 rounded bg-slate-200 skeleton-shimmer" />
                  </div>
                  <div className="h-4 w-24 rounded bg-slate-200 skeleton-shimmer" />
                  <div className="h-3 w-32 rounded bg-slate-100 skeleton-shimmer" />
                </div>
              ))}
            </div>
          </div>

          {/* Data Table / Content Skeleton */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="h-4 w-48 rounded bg-slate-200 skeleton-shimmer" />
              <div className="h-3 w-20 rounded bg-slate-100 skeleton-shimmer" />
            </div>
            <div className="space-y-2.5">
              {[1, 2, 3, 4, 5].map((i) => (
                <div
                  key={i}
                  className="h-10 w-full rounded-lg bg-slate-50 border border-slate-100 skeleton-shimmer"
                />
              ))}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
