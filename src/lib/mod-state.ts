import type { BuildSession } from "@/hooks/use-build-sessions";
import type { ModConfig, ModStatus } from "@/lib/api";
import { timeAgo } from "@/lib/format";

export type ModState = "building" | "missing" | "blocked" | "failed" | "changed" | "built" | "new";

export function modState(mod: ModConfig, status: ModStatus | undefined, session: BuildSession | undefined): ModState {
  if (session?.running) return "building";
  if (status && !status.sourceExists) return "missing";
  if (status?.problem) return "blocked";
  const last = mod.lastBuild;
  if (!last) return "new";
  if (!last.ok) return "failed";
  if (status?.lastModified && status.lastModified > last.finishedAt) return "changed";
  return "built";
}

/** Whether "Build changed" should include this mod. */
export function needsBuild(state: ModState): boolean {
  return state === "changed" || state === "new" || state === "failed";
}

export function stateLabel(state: ModState, mod: ModConfig): string {
  switch (state) {
    case "building":
      return "Building…";
    case "missing":
      return "Source folder missing";
    case "blocked":
      return "Can't build yet";
    case "failed":
      return "Last build failed";
    case "changed":
      return "Changed since last build";
    case "new":
      return "Not built yet";
    case "built":
      return mod.lastBuild ? `Built ${timeAgo(mod.lastBuild.finishedAt)}` : "Built";
  }
}

export const STATE_DOT: Record<ModState, string> = {
  building: "bg-info motion-safe:animate-pulse",
  missing: "bg-destructive",
  blocked: "bg-destructive",
  failed: "bg-destructive",
  changed: "bg-warning",
  new: "bg-muted-foreground/50",
  built: "bg-success",
};
