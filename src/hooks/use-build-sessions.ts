import { useCallback, useEffect, useRef, useState } from "react";

import {
  onBuildEvent,
  type BuildEvent,
  type BuildOutcome,
  type LogLevel,
  type Step,
  type StepStatus,
} from "@/lib/api";

/** Keeps memory bounded when pboProject is noisy. */
export const MAX_LOG_LINES = 5000;

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

/** Applies a batch of events, adding each mod's new lines to its log at once rather than copying it for every line. */
function applyEvents(current: Record<string, BuildSession>, events: BuildEvent[]): Record<string, BuildSession> {
  const next = { ...current };
  const added: Record<string, LogLine[]> = {};
  for (const event of events) {
    const session = next[event.modId];
    if (!session) continue;
    if (event.type === "step") {
      next[event.modId] = { ...session, steps: { ...session.steps, [event.step]: event.status } };
    } else {
      (added[event.modId] ??= []).push({ id: nextLineId++, level: event.level, text: event.text });
    }
  }
  for (const [modId, lines] of Object.entries(added)) {
    const log = next[modId].log.concat(lines);
    next[modId] = { ...next[modId], log: log.length > MAX_LOG_LINES ? log.slice(-MAX_LOG_LINES) : log };
  }
  return next;
}

export function useBuildSessions() {
  const [sessions, setSessions] = useState<Record<string, BuildSession>>({});
  // pboProject can print hundreds of lines a second. They're gathered and applied once a frame, so the tool
  // renders at most once a frame rather than once a line.
  const pending = useRef<BuildEvent[]>([]);
  const frame = useRef(0);

  const flush = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const events = pending.current;
    pending.current = [];
    if (events.length > 0) setSessions((current) => applyEvents(current, events));
  }, []);

  useEffect(() => {
    const unlisten = onBuildEvent((event) => {
      pending.current.push(event);
      if (!frame.current) frame.current = requestAnimationFrame(flush);
    });
    return () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      void unlisten.then((stop) => stop());
    };
  }, [flush]);

  const start = useCallback((modId: string) => {
    setSessions((current) => ({
      ...current,
      [modId]: { running: true, startedAt: Date.now(), steps: {}, log: [], outcome: null },
    }));
  }, []);

  const finish = useCallback((modId: string, outcome: BuildOutcome | null, error?: string) => {
    // The build's last lines first, so they come before anything added here.
    flush();
    setSessions((current) => {
      const session = current[modId];
      if (!session) return current;
      const log = error ? [...session.log, { id: nextLineId++, level: "error" as const, text: error }] : session.log;
      return { ...current, [modId]: { ...session, running: false, outcome, log } };
    });
  }, [flush]);

  return { sessions, start, finish };
}
