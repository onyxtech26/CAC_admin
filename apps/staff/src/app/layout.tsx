import type { Metadata } from "next";
import { JetBrains_Mono, Playfair_Display, Poppins } from "next/font/google";
import "./globals.css";

/**
 * The public site's three typefaces, self-hosted.
 *
 * `next/font/google` downloads them at build time and serves them from this origin, which is the
 * only way they can be used here at all: the CSP is `font-src 'self'` and `style-src 'self'`, so a
 * `<link>` to fonts.googleapis.com would be blocked — and weakening the policy to admit a font CDN
 * would be paying for a typeface with an origin that may execute nothing but may certainly observe
 * every staff page load.
 *
 * The weights are only those actually used. A display family shipped at nine weights is most of a
 * megabyte that nobody reads.
 */
const display = Playfair_Display({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-display-loaded",
  display: "swap",
});

const body = Poppins({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-body-loaded",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono-loaded",
  display: "swap",
});

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "CAC Internal Platform",
  description: "Conglomerate Appraisal Consultancy — internal operations.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} ${mono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
