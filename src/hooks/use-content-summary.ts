import { useEffect, useState } from "react";

import { api, type ContentSummary } from "@/lib/api";

/** Summarises a folder to upload, waiting briefly so typing a path doesn't scan on every keystroke. */
export function useContentSummary(path: string) {
  const [summary, setSummary] = useState<ContentSummary | null>(null);

  useEffect(() => {
    if (!path.trim()) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const result = await api.inspectContent(path.trim());
      if (!cancelled) setSummary(result);
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [path]);

  return summary;
}
