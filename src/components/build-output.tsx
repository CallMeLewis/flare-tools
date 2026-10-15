import { memo, useEffect, useRef } from "react";
import { CheckIcon, ChevronRightIcon, CopyIcon, MinusIcon, XIcon } from "lucide-react";
import { toast } from "sonner";

import { DisabledHint } from "@/components/disabled-hint";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { BuildSession, LogLine } from "@/hooks/use-build-sessions";
import type { LogLevel, Step, StepStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

const STEPS: { step: Step; label: string }[] = [
  { step: "prepare", label: "Prepare" },
  { step: "pack", label: "Pack" },
  { step: "sign", label: "Sign" },
  { step: "finish", label: "Finish" },
];

const LEVEL_CLASS: Record<LogLevel, string> = {
  info: "text-muted-foreground",
  command: "text-info",
  output: "text-foreground/85",
  warning: "text-warning",
  error: "text-destructive",
  success: "text-success",
};

const STATUS_LABEL: Record<StepStatus, string> = {
  running: "running",
  done: "done",
  failed: "failed",
  skipped: "skipped",
};

function StepIcon({ status }: { status: StepStatus | undefined }) {
  switch (status) {
    case "running":
      return <Spinner className="size-3.5" />;
    case "done":
      return <CheckIcon className="size-3.5 text-success" />;
    case "failed":
      return <XIcon className="size-3.5 text-destructive" />;
    case "skipped":
      return <MinusIcon className="size-3.5 text-muted-foreground" />;
    default:
      return <span className="size-1.5 rounded-full bg-muted-foreground/40" />;
  }
}

export function BuildSteps({ session }: { session: BuildSession }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Build steps" aria-live="polite">
      {STEPS.map(({ step, label }, index) => {
        const status = session.steps[step];
        return (
          <li key={step} className="flex items-center gap-1.5">
            {index > 0 && <ChevronRightIcon className="size-3 text-muted-foreground/50" aria-hidden />}
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1",
                status === "running" && "bg-muted text-foreground",
                status === "failed" && "bg-destructive/10 text-destructive",
                !status && "text-muted-foreground",
              )}
            >
              <span className="flex size-3.5 items-center justify-center">
                <StepIcon status={status} />
              </span>
              {label}
              {status && <span className="sr-only">({STATUS_LABEL[status]})</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function BuildLog({ session }: { session: BuildSession }) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow new output unless the user has scrolled up to read something.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [session.log.length]);

  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      // Focusable so the log can be scrolled with the keyboard.
      tabIndex={0}
      className="min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/60 p-3 dark:bg-background font-mono text-xs leading-relaxed outline-none select-text focus-visible:ring-3 focus-visible:ring-ring/50"
      role="log"
      // A log announces each new line by default, which is thousands in a build. The steps say how it's going.
      aria-live="off"
      aria-label="Build output"
    >
      {session.log.length === 0 ? (
        <p className="text-muted-foreground">Waiting for output…</p>
      ) : (
        session.log.map((line) => <LogRow key={line.id} line={line} />)
      )}
    </div>
  );
}

/** One line of output. Lines never change once written, so a new one doesn't re-render the thousands before it. */
const LogRow = memo(function LogRow({ line }: { line: LogLine }) {
  return (
    <div className={cn("break-all whitespace-pre-wrap", LEVEL_CLASS[line.level])}>
      {line.level === "command" ? `> ${line.text}` : line.text}
    </div>
  );
});

export function CopyLogButton({ session }: { session: BuildSession }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(session.log.map((line) => line.text).join("\n"));
      toast("Build output copied");
    } catch {
      toast.error("Couldn't copy the build output");
    }
  }

  return (
    <DisabledHint reason={session.log.length === 0 ? "There's no output to copy yet." : null}>
      <Button variant="ghost" size="xs" onClick={() => void copy()} disabled={session.log.length === 0}>
        <CopyIcon data-icon="inline-start" />
        Copy
      </Button>
    </DisabledHint>
  );
}
