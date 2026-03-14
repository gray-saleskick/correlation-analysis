"use client";

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  ReactNode,
  Suspense,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";

function PathWatcher({ onNavigated }: { onNavigated: () => void }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  useEffect(() => {
    onNavigated();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, searchParams]);
  return null;
}

export default function NavigationLoader({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const showTimeRef = useRef<number | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setVisible(true);
    showTimeRef.current = Date.now();
  }, []);

  const hide = useCallback(() => {
    if (!showTimeRef.current) return;
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    const elapsed = Date.now() - showTimeRef.current;
    const remaining = Math.max(0, 800 - elapsed);
    hideTimerRef.current = setTimeout(() => {
      setVisible(false);
      showTimeRef.current = null;
    }, remaining);
  }, []);

  // Intercept all internal link clicks instantly
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as Element;
      const anchor = target.closest("a");
      if (!anchor) return;
      // If a <button> sits between the click target and the <a>, the button
      // will likely call preventDefault/stopPropagation to prevent navigation.
      // Skip showing the loader to avoid getting stuck.
      const btn = target.closest("button");
      if (btn && anchor.contains(btn)) return;
      const href = anchor.getAttribute("href");
      if (
        !href ||
        href.startsWith("#") ||
        href.startsWith("http") ||
        href.startsWith("mailto:") ||
        href.startsWith("blob:") ||
        href.startsWith("data:") ||
        href.startsWith("javascript:") ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download")
      ) return;
      // Don't show loader if navigating to the current page (pathname won't change,
      // so PathWatcher would never fire hide() and the overlay would get stuck)
      if (href === window.location.pathname) return;
      show();
    }
    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, [show]);

  return (
    <>
      {children}

      {/* Watches pathname/searchParams to know when navigation finishes */}
      <Suspense fallback={null}>
        <PathWatcher onNavigated={hide} />
      </Suspense>

      {/* Full-screen loading overlay — shows instantly on click */}
      {visible && (
        <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-sm z-[9999] flex items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/loading.svg"
            alt="Loading…"
            className="w-36 h-36"
            style={{ animation: "sk-nav-loading 1.2s ease-in-out infinite" }}
          />
          <style>{`
            @keyframes sk-nav-loading {
              0%   { opacity: 1;   transform: scale(1); }
              50%  { opacity: 0.55; transform: scale(0.9); }
              100% { opacity: 1;   transform: scale(1); }
            }
          `}</style>
        </div>
      )}
    </>
  );
}
