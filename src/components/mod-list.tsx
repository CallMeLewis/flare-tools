import { HammerIcon, PlusIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SidebarFooter } from "@/components/sidebar-footer";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { BuildSession } from "@/hooks/use-build-sessions";
import type { ModConfig, ModStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { modState, STATE_DOT, stateLabel } from "@/lib/mod-state";

interface ModListProps {
  mods: ModConfig[];
  statuses: Record<string, ModStatus>;
  sessions: Record<string, BuildSession>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  /** Mods that have changed, failed or never been built. */
  changedCount: number;
  busy: boolean;
  onBuildChanged: () => void;
}

export function ModList({
  mods,
  statuses,
  sessions,
  selectedId,
  onSelect,
  onAdd,
  changedCount,
  busy,
  onBuildChanged,
}: ModListProps) {
  return (
    <aside className="flex w-76 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex h-16 shrink-0 items-center justify-between border-b px-3">
        <span className="text-sm font-semibold">Mods</span>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={onAdd} aria-label="Add a mod" />}>
            <PlusIcon />
          </TooltipTrigger>
          <TooltipContent side="bottom">Add a mod</TooltipContent>
        </Tooltip>
      </div>

      <nav aria-label="Mods" className="flex-1 overflow-y-auto p-2">
        {mods.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">No mods yet.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {mods.map((mod) => {
              const state = modState(mod, statuses[mod.id], sessions[mod.id]);
              const selected = mod.id === selectedId;
              return (
                <li key={mod.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(mod.id)}
                    aria-current={selected ? "page" : undefined}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                      selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
                    )}
                  >
                    <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", STATE_DOT[state])} aria-hidden />
                    <span className="flex min-w-0 flex-col">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium">{mod.name}</span>
                        {statuses[mod.id]?.version && (
                          <Badge variant="outline" className="h-4.5 shrink-0 px-1.5 font-mono font-normal text-muted-foreground">
                            {statuses[mod.id].version}
                          </Badge>
                        )}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">{stateLabel(state, mod)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      {changedCount > 1 && (
        <div className="border-t p-2">
          <Button variant="secondary" className="w-full justify-start" onClick={onBuildChanged} disabled={busy}>
            <HammerIcon data-icon="inline-start" />
            Build {changedCount} changed mods
          </Button>
        </div>
      )}

      <SidebarFooter />
    </aside>
  );
}
