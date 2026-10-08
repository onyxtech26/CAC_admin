"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 flex items-center justify-center p-6 text-slate-800 font-sans">
        <div className="max-w-xl w-full bg-white rounded-2xl shadow-lg border border-slate-200 overflow-hidden">
          <div className="bg-slate-900 px-8 py-6 text-white flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 font-bold text-xl">
              CAC
            </div>
            <div>
              <h1 className="text-lg font-semibold text-white tracking-wide">
                Platform Diagnostic
              </h1>
              <p className="text-xs text-slate-400">
                Conglomerate Appraisal Consultancy — Platform Service
              </p>
            </div>
          </div>
          <div className="p-8 space-y-6">
            <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-sm text-amber-900">
              <p className="font-semibold mb-1">Configuration Notice</p>
              <p className="text-xs text-amber-800 leading-relaxed">
                {error.message || "A platform configuration or connection error occurred."}
              </p>
            </div>
            <div className="flex items-center gap-3 pt-2 border-t border-slate-100">
              <button
                onClick={() => reset()}
                className="px-5 py-2.5 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 transition"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
