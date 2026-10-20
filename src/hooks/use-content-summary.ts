import { useEffect, useState } from "react";

import { api, type ContentSummary } from "@/lib/api";

/**
 * Summarises a folder to upload, waiting briefly so typing a path doesn't scan on every keystroke. It's read again each
 * time the upload window opens and when the app comes back into focus, to pick up changes made outside the app.
 */
export function useContentSummary(path: string, open: boolean) {
  // Kept with the folder it's for, so another folder's summary never shows while this one's is read.
  const [summary, setSummary] = useState<{ path: string; summary: ContentSummary | null } | null>(null);
  const [focused, setFocused] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  const folder = path.trim();

  // The summary from the last time the window was open may be out of date, so it isn't shown again.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSummary(null);
  }

  useEffect(() => {
    if (!open) return;
    const onFocus = () => setFocused((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [open]);

  useEffect(() => {
    if (!folder || !open) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const result = await api.inspectContent(folder).catch(() => null);
      if (!cancelled) setSummary({ path: folder, summary: result });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [folder, open, focused]);

  return folder && summary?.path === folder ? summary.summary : null;
}
