import { createContext, useContext } from "react";
import type { LucideIcon } from "lucide-react";
import { MonitorIcon, MoonIcon, SettingsIcon, SunIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UpdateButton } from "@/components/update-button";
import type { ThemePreference } from "@/lib/theme";

interface SidebarFooterActions {
  onOpenSettings: () => void;
  theme: ThemePreference;
  /** Moves to the next theme: system, light, dark, and round again. */
  onCycleTheme: () => void;
}

/** Provided by the app, so every tool's sidebar can show the same footer without passing it down. */
export const SidebarFooterContext = createContext<SidebarFooterActions | null>(null);

const THEME_ICON: Record<ThemePreference, LucideIcon> = { system: MonitorIcon, light: SunIcon, dark: MoonIcon };
const THEME_LABEL: Record<ThemePreference, string> = { system: "System", light: "Light", dark: "Dark" };

/** Settings, the theme switch and the update button, pinned to the bottom of a tool's sidebar. */
export function SidebarFooter() {
  const actions = useContext(SidebarFooterContext);
  if (!actions) throw new Error("SidebarFooter needs a SidebarFooterContext provider.");
  const { onOpenSettings, theme, onCycleTheme } = actions;
  const ThemeIcon = THEME_ICON[theme];

  return (
    <div className="flex shrink-0 items-center gap-1 border-t p-2">
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-lg" onClick={onOpenSettings} aria-label="Settings" />}>
          <SettingsIcon className="size-5" />
        </TooltipTrigger>
        <TooltipContent side="top">Settings</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={<Button variant="ghost" size="icon-lg" onClick={onCycleTheme} aria-label={`Theme: ${THEME_LABEL[theme]}`} />}
        >
          <ThemeIcon className="size-5" />
        </TooltipTrigger>
        <TooltipContent side="top">Theme: {THEME_LABEL[theme]}. Click to change.</TooltipContent>
      </Tooltip>
      {/* On the right, apart from the two that change how the app looks. */}
      <div className="ml-auto">
        <UpdateButton />
      </div>
    </div>
  );
}
