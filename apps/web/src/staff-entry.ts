/**
 * The way in to the staff platform from the public site.
 *
 * CAC asked for a double-click on HOME to open the staff login, alongside a sentence that matters
 * more than the gesture does: **security must never depend upon the login page being hidden.** So
 * both halves of that are true here.
 *
 * The gesture is a convenience for whoever is at the front desk, and nothing more. The staff login
 * is an ordinary URL: typing it works, bookmarking it works, and a keyboard user who cannot perform
 * a double-click is not shut out — they are told the address, which is not a secret. What protects
 * the platform is the session, the second factor, the capability checks on every route and the
 * server-side guards on every page; a URL nobody advertises protects nothing and is not treated as
 * though it did.
 *
 * There is deliberately **no visible link**, because the public site is for CAC's clients and a
 * staff entrance in the footer invites people to try it. That is a matter of tidiness, not of
 * security, and the distinction is the whole point.
 *
 * Where the staff app lives is a deployment question (Q-INFRA-1), so it is a build-time variable
 * rather than a constant. The default assumes the two are served under one origin with the staff
 * app behind `/staff`, which is the arrangement that needs no cross-origin cookie.
 */

const CONFIGURED = import.meta.env.VITE_STAFF_LOGIN_URL as string | undefined;

/**
 * Where the staff login is, for this build.
 *
 * The production default assumes one origin with the staff app behind `/staff`. In development the
 * two are separate servers on separate ports, so that path does not exist and the gesture led to
 * the site's own 404 — the one case where the entrance is genuinely broken rather than merely
 * unadvertised. Development therefore falls back to the staff dev server's own address.
 *
 * `VITE_STAFF_LOGIN_URL` still overrides both, which is what a deployment sets (Q-INFRA-1).
 */
const DEV_DEFAULT = "http://localhost:3100/login";

export const STAFF_LOGIN_URL =
  (CONFIGURED && CONFIGURED.trim()) || (import.meta.env.DEV ? DEV_DEFAULT : "/staff/login");

/**
 * Sends the browser to the staff login.
 *
 * A full navigation rather than a router push: it is a different application, usually a different
 * origin, and the router knows nothing about it.
 */
export function openStaffLogin(): void {
  window.location.href = STAFF_LOGIN_URL;
}

/**
 * Turns a double-click into that navigation.
 *
 * Returns the props to spread onto the element, so the gesture is declared in one place and the
 * component that carries it does not have to explain itself.
 *
 * `preventDefault` stops the element's own click from also running — on the brand link that would
 * mean navigating home and then away again, which flickers.
 */
export function staffEntryProps(): {
  onDoubleClick: (event: { preventDefault: () => void }) => void;
} {
  return {
    onDoubleClick: (event) => {
      event.preventDefault();
      openStaffLogin();
    },
  };
}
