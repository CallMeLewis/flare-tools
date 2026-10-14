import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { CopyIcon, MinusIcon, SquareIcon, XIcon } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface ToolDefinition<Id extends string> {
  id: Id;
  label: string;
  icon: LucideIcon;
}

interface TitleBarProps<Id extends string> {
  tools: ToolDefinition<Id>[];
  active: Id;
  onSelect: (id: Id) => void;
  /** Tools with work in progress get a dot, so it's visible from the other tools. */
  busy: Partial<Record<Id, boolean>>;
}

const appWindow = getCurrentWindow();

function useMaximised() {
  const [maximised, setMaximised] = useState(false);
  useEffect(() => {
    void appWindow.isMaximized().then(setMaximised);
    const unlisten = appWindow.onResized(() => void appWindow.isMaximized().then(setMaximised));
    return () => void unlisten.then((stop) => stop());
  }, []);
  return maximised;
}

const WINDOW_BUTTON =
  "flex h-full w-12 items-center justify-center text-muted-foreground outline-none transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:bg-foreground/10 focus-visible:text-foreground [&_svg]:size-4";

/** The window's title bar: the app's tools and the window buttons, in place of Windows' own. */
export function TitleBar<Id extends string>({
  tools,
  active,
  onSelect,
  busy,
}: TitleBarProps<Id>) {
  const maximised = useMaximised();

  return (
    // Tauri drags the window from elements marked as a drag region, and maximises on double-click.
    <header data-tauri-drag-region className="flex h-11 shrink-0 items-center border-b bg-sidebar select-none">
      <div data-tauri-drag-region className="flex items-center gap-2 pr-4 pl-3">
        <img src="/icon.svg" alt="" className="pointer-events-none size-6" />
        <span data-tauri-drag-region className="text-sm font-semibold">
          Flare Tools
        </span>
      </div>

      <nav aria-label="Tools" className="flex items-center gap-1">
        {tools.map(({ id, label, icon: Icon }, index) => {
          const selected = id === active;
          return (
            <Tooltip key={id}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => onSelect(id)}
                    aria-current={selected ? "page" : undefined}
                    className={cn(
                      "flex h-8 items-center gap-2 rounded-md px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                      selected
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                    )}
                  />
                }
              >
                <Icon className="size-4" aria-hidden />
                {label}
                {busy[id] && (
                  <span className="size-1.5 animate-pulse rounded-full bg-warning motion-reduce:animate-none">
                    <span className="sr-only">(working)</span>
                  </span>
                )}
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {label}
                <Kbd>Ctrl {index + 1}</Kbd>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </nav>

      <div data-tauri-drag-region className="h-full flex-1" />

      <div className="flex h-full items-center gap-1 pr-2">
      </div>

      <div className="flex h-full border-l">
        <button type="button" className={WINDOW_BUTTON} onClick={() => void appWindow.minimize()} aria-label="Minimise">
          <MinusIcon />
        </button>
        <button
          type="button"
          className={WINDOW_BUTTON}
          onClick={() => void appWindow.toggleMaximize()}
          aria-label={maximised ? "Restore" : "Maximise"}
        >
          {maximised ? <CopyIcon className="-scale-x-100" /> : <SquareIcon className="size-3.5!" />}
        </button>
        <button
          type="button"
          className={cn(WINDOW_BUTTON, "hover:bg-red-600 hover:text-white focus-visible:bg-red-600 focus-visible:text-white")}
          onClick={() => void appWindow.close()}
          aria-label="Close"
        >
          <XIcon />
        </button>
      </div>
    </header>
  );
}
