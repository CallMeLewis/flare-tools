import { useEffect, useState } from "react";

import { api, type Inspection } from "@/lib/api";

/** Inspects a mod folder, waiting briefly so typing a path doesn't scan on every keystroke. */
export function useInspection(sourcePath: string, prefix: string | null, pboName: string | null, refreshKey = 0) {
  const [inspection, setInspection] = useState<Inspection | null>(null);

  useEffect(() => {
    if (!sourcePath.trim()) {
      setInspection(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const result = await api.inspectMod(sourcePath, prefix || null, pboName || null).catch(() => null);
      if (!cancelled) setInspection(result);
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sourcePath, prefix, pboName, refreshKey]);

  return inspection;
}
