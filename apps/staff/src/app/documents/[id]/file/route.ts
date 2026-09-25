import { NextResponse } from "next/server";
import { getDb } from "@cac/db";
import { documentBytes, isUserFacingError } from "@cac/core";
import { getRequestContext, requireCapability } from "@/lib/auth";

/**
 * The stored original.
 *
 * Refuses anything that has not cleared quarantine, and writes an audit row every time a
 * file is served — a download is the moment a document leaves the platform, and that is
 * worth recording whoever asks for it.
 *
 * `content-disposition: attachment` for everything, deliberately. Rendering an arbitrary
 * uploaded file inline means the browser executing whatever is in it against this origin,
 * and a document library is exactly where somebody's HTML or SVG would arrive. The
 * download is the point; the preview is not worth that.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("doc.download");
  const { id } = await params;
  const db = await getDb();
  const context = await getRequestContext();

  try {
    const file = await documentBytes(db, principal, id, {
      reason: null,
      context,
    });

    return new NextResponse(new Uint8Array(file.bytes), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${file.filename.replace(/["\\]/g, "")}"`,
        // Nothing caches a client's document, not even the browser's disk.
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (isUserFacingError(error)) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "FORBIDDEN" ? 403 : 409;
      return new NextResponse(error.message, { status });
    }
    console.error("[documents] unexpected error serving a file:", error);
    return new NextResponse("That file could not be served.", { status: 500 });
  }
}
