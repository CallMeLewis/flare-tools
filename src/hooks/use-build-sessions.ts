import { useCallback, useEffect, useState } from "react";

import { onBuildEvent, type BuildOutcome, type LogLevel, type Step, type StepStatus } from "@/lib/api";

/** Keeps memory bounded when pboProject is noisy. */
const MAX_LOG_LINES = 5000;

export interface LogLine {
  id: number;
  level: LogLevel;
  text: string;
}

export interface BuildSession {
  running: boolean;
  startedAt: number;
  steps: Partial<Record<Step, StepStatus>>;
  log: LogLine[];
  outcome: BuildOutcome | null;
}

let nextLineId = 0;

export function useBuildSessions() {
  const [sessions, setSessions] = useState<Record<string, BuildSession>>({});

  useEffect(() => {
    const unlisten = onBuildEvent((event) => {
      setSessions((current) => {
        const session = current[event.modId];
        if (!session) return current;
        if (event.type === "step") {
          return { ...current, [event.modId]: { ...session, steps: { ...session.steps, [event.step]: event.status } } };
        }
        const log = [...session.log, { id: nextLineId++, level: event.level, text: event.text }];
        return {
          ...current,
          [event.modId]: { ...session, log: log.length > MAX_LOG_LINES ? log.slice(-MAX_LOG_LINES) : log },
        };
      });
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  const start = useCallback((modId: string) => {
    setSessions((current) => ({
      ...current,
      [modId]: { running: true, startedAt: Date.now(), steps: {}, log: [], outcome: null },
    }));
  }, []);

  const finish = useCallback((modId: string, outcome: BuildOutcome | null, error?: string) => {
    setSessions((current) => {
      const session = current[modId];
      if (!session) return current;
      const log = error ? [...session.log, { id: nextLineId++, level: "error" as const, text: error }] : session.log;
      return { ...current, [modId]: { ...session, running: false, outcome, log } };
    });
  }, []);

  return { sessions, start, finish };
}
