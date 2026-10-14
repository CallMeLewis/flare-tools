import { useEffect, useState } from "react";

import { api, type SteamPresence } from "@/lib/api";

// Reading it is only a registry lookup, so it can be checked often enough to feel immediate.
const POLL_MS = 2000;

/** Whether the Steam client is running and signed in, kept current. Null until the first check. */
export function useSteamPresence(): SteamPresence | null {
  const [presence, setPresence] = useState<SteamPresence | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const check = async () => {
      try {
        const next = await api.steamPresence();
        if (!cancelled) setPresence(next);
      } catch {
        // Keep the last answer; the next check tries again.
      }
      if (!cancelled) timer = window.setTimeout(check, POLL_MS);
    };
    void check();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);
  return presence;
}
