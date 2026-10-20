import { useEffect, useState } from "react";

import { api, type Inspection } from "@/lib/api";

/** Inspects a mod folder, waiting briefly so typing a path doesn't scan on every keystroke. */
export function useInspection(sourcePath: string, prefix: string | null, pboName: string | null, refreshKey = 0) {
  // Kept with the folder it's for, so another mod's PBOs never show while this one's are read. A new prefix or PBO
  // name keeps showing the last result until the new one is in, rather than flickering while it's typed.
  const [inspection, setInspection] = useState<{ sourcePath: string; inspection: Inspection | null } | null>(null);

  useEffect(() => {
    if (!sourcePath.trim()) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const result = await api.inspectMod(sourcePath, prefix || null, pboName || null).catch(() => null);
      if (!cancelled) setInspection({ sourcePath, inspection: result });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sourcePath, prefix, pboName, refreshKey]);

  return sourcePath.trim() && inspection?.sourcePath === sourcePath ? inspection.inspection : null;
}
