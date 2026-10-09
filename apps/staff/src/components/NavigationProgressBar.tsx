"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * High-performance enterprise top navigation progress indicator.
 *
 * Provides immediate (0ms) visual responsiveness when clicking any route transition
 * across the platform, eliminating perceived lag and uncertainty while Next.js
 * App Router renders and streams server-side payloads.
 */
export function NavigationProgressBar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const [opacity, setOpacity] = useState(1);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const resetTimerRef = useRef<NodeJS.Timeout | null>(null);

  // When pathname or searchParams change, the navigation has completed.
  useEffect(() => {
    if (visible) {
      setProgress(100);
      setOpacity(1);

      // Gracefully fade out after reaching 100%
      resetTimerRef.current = setTimeout(() => {
        setOpacity(0);
        const hideTimer = setTimeout(() => {
          setVisible(false);
          setProgress(0);
          setOpacity(1);
        }, 200);
        return () => clearTimeout(hideTimer);
      }, 250);
    }

    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, [pathname, searchParams]);

  // Intercept all internal link clicks across the application
  useEffect(() => {
    function handleAnchorClick(e: MouseEvent) {
      // Ignore modified or non-primary clicks
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return;
      }

      // Find the closest anchor tag
      const anchor = (e.target as Element | null)?.closest("a");
      if (!anchor) return;

      const href = anchor.getAttribute("href");
      if (!href) return;

      // Ignore non-navigation links
      if (
        href.startsWith("#") ||
        href.startsWith("mailto:") ||
        href.startsWith("tel:") ||
        href.startsWith("javascript:") ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download")
      ) {
        return;
      }

      // Check URL origin and destination
      try {
        const targetUrl = new URL(anchor.href, window.location.href);
        const currentUrl = new URL(window.location.href);

        // Ignore external navigation
        if (targetUrl.origin !== currentUrl.origin) return;

        // Ignore links pointing to the exact same page & search query
        if (
          targetUrl.pathname === currentUrl.pathname &&
          targetUrl.search === currentUrl.search
        ) {
          return;
        }

        // Start progress bar immediately
        if (timerRef.current) clearInterval(timerRef.current);
        if (resetTimerRef.current) clearTimeout(resetTimerRef.current);

        setVisible(true);
        setOpacity(1);
        setProgress(28);

        // Smooth multi-stage easing progress
        let currentProgress = 28;
        timerRef.current = setInterval(() => {
          currentProgress += Math.max(1, (90 - currentProgress) * 0.18);
          if (currentProgress >= 90) {
            currentProgress = 90;
            if (timerRef.current) clearInterval(timerRef.current);
          }
          setProgress(currentProgress);
        }, 150);

        // Safety timeout in case navigation is aborted or fails
        setTimeout(() => {
          if (timerRef.current) clearInterval(timerRef.current);
        }, 8000);
      } catch {
        // Safe fallback for malformed URLs
      }
    }

    document.addEventListener("click", handleAnchorClick, true);

    return () => {
      document.removeEventListener("click", handleAnchorClick, true);
      if (timerRef.current) clearInterval(timerRef.current);
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  if (!visible && progress === 0) return null;

  return (
    <div
      className="nav-progress-bar-container"
      style={{ opacity, transition: "opacity 200ms ease" }}
      aria-hidden="true"
    >
      <div
        className="nav-progress-bar"
        style={{
          width: `${progress}%`,
        }}
      />
    </div>
  );
}
