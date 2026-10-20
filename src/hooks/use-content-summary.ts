import { useEffect, useState } from "react";

import { api, type ContentSummary } from "@/lib/api";

/** Summarises a folder to upload, waiting briefly so typing a path doesn't scan on every keystroke. */
export function useContentSummary(path: string) {
  // Kept with the folder it's for, so another folder's summary never shows while this one's is read.
  const [summary, setSummary] = useState<{ path: string; summary: ContentSummary | null } | null>(null);
  const folder = path.trim();

  useEffect(() => {
    if (!folder) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const result = await api.inspectContent(folder).catch(() => null);
      if (!cancelled) setSummary({ path: folder, summary: result });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [folder]);

  return folder && summary?.path === folder ? summary.summary : null;
}
