import type { Metadata } from "next";
import { Suspense } from "react";
import { NavigationProgressBar } from "@/components/NavigationProgressBar";
import "./globals.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "CAC Internal Platform",
  description: "Conglomerate Appraisal Consultancy — internal operations.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Suspense fallback={null}>
          <NavigationProgressBar />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
