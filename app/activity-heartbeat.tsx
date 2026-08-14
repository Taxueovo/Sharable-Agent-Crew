"use client";

import { useEffect } from "react";

export default function ActivityHeartbeat() {
  useEffect(() => {
    if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)) return;
    let lastSentAt = 0;
    const reportActivity = () => {
      const now = Date.now();
      if (now - lastSentAt < 10_000) return;
      lastSentAt = now;
      void fetch("/api/local-activity", { method: "POST", cache: "no-store", keepalive: true }).catch(() => undefined);
    };
    const visibilityChanged = () => { if (document.visibilityState === "visible") reportActivity(); };
    // When the browser/tab truly closes, tell the local launcher it should exit.
    // Refreshing the page also fires pagehide, but persisted === true means a bfcache
    // restore, which is skipped; a normal refresh cancels the launcher's exit timer
    // because the newly loaded page sends a heartbeat right away.
    const notifyClosing = () => {
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/local-activity?close=1");
      } else {
        fetch("/api/local-activity?close=1", { method: "POST", keepalive: true }).catch(() => undefined);
      }
    };
    const pageHidden = (event: PageTransitionEvent) => { if (!event.persisted) notifyClosing(); };
    reportActivity();
    window.addEventListener("pointerdown", reportActivity, { passive: true });
    window.addEventListener("keydown", reportActivity);
    window.addEventListener("scroll", reportActivity, { passive: true });
    window.addEventListener("focus", reportActivity);
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("pagehide", pageHidden);
    return () => {
      window.removeEventListener("pointerdown", reportActivity);
      window.removeEventListener("keydown", reportActivity);
      window.removeEventListener("scroll", reportActivity);
      window.removeEventListener("focus", reportActivity);
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("pagehide", pageHidden);
    };
  }, []);
  return null;
}
