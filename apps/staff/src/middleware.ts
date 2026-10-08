import { NextResponse, type NextRequest } from "next/server";

/**
 * The two security headers that cannot be static.
 *
 * Four others are set in `next.config.ts`, where a constant value is the right shape. These two are
 * not constants:
 *
 * **Content-Security-Policy** needs a fresh nonce per response. The alternative is
 * `script-src 'unsafe-inline'`, which is the same as not having the header for the attack it exists
 * to stop — and this application renders case files, letters and payslips, so a script that reached
 * the page would be reading exactly the material the whole platform is careful about. Next.js
 * propagates the nonce to its own hydration scripts when it sees one in this header, and
 * `strict-dynamic` lets those scripts load their chunks; nothing else runs.
 *
 * **Strict-Transport-Security** is sent only over HTTPS. Sent on a plain-HTTP development origin it
 * would pin `localhost` to HTTPS in the developer's browser for a year, which is a footgun with a
 * very long fuse and no benefit.
 *
 * `style-src` keeps `'unsafe-inline'`, and that is a deliberate, narrow concession: React writes
 * inline `style` attributes, and a nonce does not cover attributes. `img-src` allows `data:` because
 * the authenticator QR is rendered on the server into a data URL precisely so the QR library never
 * reaches the browser.
 */
export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());

  // React Refresh compiles hot updates with `eval`, and only in development. Allowing it there keeps
  // the policy identical in shape to the one that ships, which is the point — a CSP that is only
  // switched on in production is a CSP nobody has tested.
  const hotReload = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${hotReload}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self'`,
    // Nothing here talks to anywhere else. If that changes, it changes here first.
    `connect-src 'self'`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ].join("; ");

  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);

  const forwardedProto = request.headers.get("x-forwarded-proto");
  const secure = forwardedProto === "https" || request.nextUrl.protocol === "https:";
  if (secure) {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload",
    );
  }

  return response;
}

export const config = {
  // Everything but the static assets, which are served straight from disk and carry no markup.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
