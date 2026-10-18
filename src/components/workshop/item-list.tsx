import { ImageIcon, PlusIcon, RefreshCwIcon } from "lucide-react";

import { DisabledHint } from "@/components/disabled-hint";
import { Button } from "@flare/ui/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@flare/ui/ui/tooltip";
import type { SteamStatus, WorkshopItem } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { VISIBILITY_LABEL } from "@/lib/workshop";

interface ItemListProps {
  steam: SteamStatus | null;
  items: WorkshopItem[] | null;
  /** The selected item's id, or "new" while a new item is being written. */
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  /** Steam has gone away. Refreshing waits for it, so the open item stays as it is. */
  offline: boolean;
}

export function Thumbnail({ src, className }: { src: string | null; className?: string }) {
  return (
    <span className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted", className)}>
      {src ? (
        <img src={src} alt="" className="size-full object-cover" loading="lazy" />
      ) : (
        <ImageIcon className="size-4 text-muted-foreground" aria-hidden />
      )}
    </span>
  );
}

export function ItemList({ steam, items, selectedId, onSelect, onNew, onRefresh, refreshing, offline }: ItemListProps) {
  const ready = steam?.state === "ready";
  // Why the buttons that need Steam can't be used, when they can't.
  const steamHint = !steam
    ? "Connecting to Steam…"
    : offline
      ? "Steam isn't connected."
      : !ready
        ? "Can't reach Steam."
        : null;

  return (
    // A card below the page's header, like the ones beside it, rather than a second sidebar next to the app's.
    <aside className="m-4 mr-0 flex w-72 shrink-0 flex-col overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10">
      <div className="flex h-12 shrink-0 items-center justify-between gap-1 border-b pr-2 pl-4">
        <span className="font-heading text-base leading-snug font-medium">Workshop items</span>
        <div className="flex">
          {/* Refresh stays available when Steam can't be reached, since it's how to try again. */}
          <DisabledHint reason={!refreshing && (!steam || offline) ? steamHint : null}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onRefresh}
                  disabled={!steam || refreshing || offline}
                  aria-label="Refresh from Steam"
                >
                  <RefreshCwIcon className={cn(refreshing && "animate-spin motion-reduce:animate-none")} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Refresh from Steam</TooltipContent>
            </Tooltip>
          </DisabledHint>
          <DisabledHint reason={ready ? null : steamHint}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={onNew} disabled={!ready} aria-label="New Workshop item">
                  <PlusIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">New Workshop item</TooltipContent>
            </Tooltip>
          </DisabledHint>
        </div>
      </div>

      <nav aria-label="Workshop items" className="flex-1 overflow-y-auto p-2">
        {!steam || (ready && !items) ? (
          <p className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
            <Spinner className="size-3.5" />
            {steam ? "Loading your items…" : "Connecting to Steam…"}
          </p>
        ) : !ready ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">Not connected to Steam.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {selectedId === "new" && (
              <li>
                <div
                  aria-current="page"
                  className="flex items-center gap-2.5 rounded-lg bg-sidebar-accent px-2.5 py-2 text-sidebar-accent-foreground"
                >
                  <Thumbnail src={null} className="size-9" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">New item</span>
                    <span className="truncate text-xs text-muted-foreground">Not published yet</span>
                  </span>
                </div>
              </li>
            )}
            {items!.length === 0 && selectedId !== "new" && (
              <li className="px-2 py-3 text-xs text-muted-foreground">You haven't published anything for DayZ yet.</li>
            )}
            {items!.map((item) => {
              const selected = item.id === selectedId;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(item.id)}
                    aria-current={selected ? "page" : undefined}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                      selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
                    )}
                  >
                    <Thumbnail src={item.previewUrl} className="size-9" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium" title={item.title || undefined}>
                        {item.title || "Untitled"}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {VISIBILITY_LABEL[item.visibility]} · {timeAgo(item.timeUpdated)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </aside>
  );
}
