"use client";

import { useEffect } from "react";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[CAC Platform Error]:", error);
  }, [error]);

  const isDbError =
    error.message?.toLowerCase().includes("database") ||
    error.message?.toLowerCase().includes("relation") ||
    error.message?.toLowerCase().includes("pglite") ||
    error.message?.toLowerCase().includes("connection") ||
    error.message?.toLowerCase().includes("postgres");

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6 text-slate-800 font-sans">
      <div className="max-w-xl w-full bg-white rounded-2xl shadow-lg border border-slate-200 overflow-hidden">
        {/* Header */}
        <div className="bg-slate-900 px-8 py-6 text-white flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 font-bold text-xl">
            CAC
          </div>
          <div>
            <h1 className="text-lg font-semibold text-white tracking-wide">
              {isDbError ? "Database Setup Required" : "System Notification"}
            </h1>
            <p className="text-xs text-slate-400">
              Conglomerate Appraisal Consultancy — Platform Service
            </p>
          </div>
        </div>

        {/* Content */}
        <div className="p-8 space-y-6">
          {isDbError ? (
            <div className="space-y-4">
              <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-sm text-amber-900">
                <p className="font-semibold mb-1">Cloud Database Not Detected</p>
                <p className="text-xs text-amber-800 leading-relaxed">
                  The CAC Enterprise Platform requires a persistent PostgreSQL database connection
                  string when running in production on Vercel.
                </p>
              </div>

              <div className="space-y-3 text-xs text-slate-600">
                <p className="font-medium text-slate-900 uppercase tracking-wider text-[11px]">
                  How to connect in 2 minutes:
                </p>
                <ol className="list-decimal list-inside space-y-2 pl-1 leading-relaxed">
                  <li>
                    Log in to your <strong>Vercel Dashboard</strong> and navigate to your{" "}
                    <strong>CAC_admin</strong> project.
                  </li>
                  <li>
                    Go to <strong>Settings</strong> &rarr; <strong>Environment Variables</strong>.
                  </li>
                  <li>
                    Add variable name <code>DATABASE_URL</code> with your PostgreSQL connection string
                    (e.g., from Neon, Supabase, or Vercel Postgres:{" "}
                    <code>postgres://username:password@ep-...neon.tech/neondb?sslmode=require</code>).
                  </li>
                  <li>
                    Redeploy or refresh this page. Tables, roles, and default accounts will be
                    automatically initialized on first boot.
                  </li>
                </ol>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-slate-700 leading-relaxed">
                An unexpected condition was encountered during request handling. The platform
                safeguarded your session.
              </p>
              <div className="p-3 bg-slate-100 rounded-lg text-xs font-mono text-slate-700 break-all border border-slate-200">
                {error.message || "An error occurred while loading this page."}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2 border-t border-slate-100">
            <button
              onClick={() => reset()}
              className="px-5 py-2.5 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 transition shadow-sm"
            >
              Retry Connection
            </button>
            <a
              href="/"
              className="px-5 py-2.5 rounded-lg bg-slate-100 text-slate-700 text-xs font-medium hover:bg-slate-200 transition"
            >
              Reload Platform
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
