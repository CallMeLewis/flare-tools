import { useEffect, useState } from "react";

import type { BuildSession } from "@/hooks/use-build-sessions";
import { api, type BuildRecord } from "@/lib/api";

/** A mod's saved builds, newest first. Reloads whenever `refreshKey` changes, e.g. after a build. */
export function useBuildHistory(modId: string, refreshKey: number): BuildRecord[] {
  const [records, setRecords] = useState<BuildRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .buildHistory(modId)
      .then((found) => !cancelled && setRecords(found))
      .catch(() => !cancelled && setRecords([]));
    return () => {
      cancelled = true;
    };
  }, [modId, refreshKey]);

  return records;
}

/** Loads a saved build's log and presents it the way a live session is, so the same views show it. */
export function useSavedBuild(modId: string, record: BuildRecord | null): BuildSession | null {
  const [session, setSession] = useState<BuildSession | null>(null);

  useEffect(() => {
    setSession(null);
    if (!record) return;
    let cancelled = false;
    api
      .buildLog(modId, record.id)
      .then((lines) => {
        if (cancelled) return;
        setSession({
          running: false,
          startedAt: record.startedAt,
          steps: Object.fromEntries(record.steps.map((s) => [s.step, s.status])),
          log: lines.map((line, id) => ({ id, ...line })),
          outcome: {
            ok: record.ok,
            cancelled: record.cancelled,
            durationMs: record.durationMs,
            finishedAt: record.finishedAt,
            pbos: record.pbos,
            signed: record.signed,
            warnings: record.warnings,
            error: record.error,
          },
        });
      })
      .catch(() => {
        if (!cancelled) {
          setSession({
            running: false,
            startedAt: record.startedAt,
            steps: {},
            log: [{ id: 0, level: "error", text: "This build's log is no longer here." }],
            outcome: null,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [modId, record]);

  return session;
}
