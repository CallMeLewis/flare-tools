import { useCallback, useEffect, useRef, useState } from "react";
import { HammerIcon, UploadCloudIcon } from "lucide-react";
import { toast } from "sonner";

import { AppShell, AppSidebar, type SidebarItem } from "@flare/ui";

import { AppMark } from "@/components/app-mark";
import { SettingsDialog } from "@/components/settings-dialog";
import { openSteam, SteamGate } from "@/components/steam-gate";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@flare/ui/ui/alert-dialog";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@flare/ui/ui/tooltip";
import { useSteamPresence } from "@/hooks/use-steam-presence";
import { api } from "@/lib/api";
import { dialogOpen } from "@/lib/shortcuts";
import { useTheme } from "@/lib/theme";
import { useUiScale } from "@/lib/ui-scale";
import { BuildTool } from "@/tools/build-tool";
import { WorkshopTool } from "@/tools/workshop-tool";

type ToolId = "build" | "workshop";

const TOOLS: Omit<SidebarItem<ToolId>, "busy">[] = [
  { id: "build", label: "Build", icon: HammerIcon },
  { id: "workshop", label: "Workshop", icon: UploadCloudIcon },
];

const TOOL_KEY = "tool";
const STEAM_TOAST = "steam-presence";

function storedTool(): ToolId {
  const stored = localStorage.getItem(TOOL_KEY);
  return TOOLS.some((t) => t.id === stored) ? (stored as ToolId) : "build";
}

export default function App() {
  const [tool, setTool] = useState<ToolId>(storedTool);
  // Tools are mounted the first time they're opened and then kept, so work in progress survives switching.
  const [opened, setOpened] = useState<Set<ToolId>>(() => new Set([tool]));
  const [busy, setBusy] = useState<Partial<Record<ToolId, boolean>>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  // Bumped on every save, so the build tool reloads the settings it builds with.
  const [settingsVersion, setSettingsVersion] = useState(0);
  // Asking whether to throw away unsaved settings, after the user tried to close them.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const theme = useTheme();
  const uiScale = useUiScale();
  const steam = useSteamPresence();
  // Steam has to be up to get in. After that, losing it only pauses publishing, so work in progress isn't lost.
  const [steamReady, setSteamReady] = useState(false);
  const steamLost = useRef(false);

  useEffect(() => {
    if (steam === "signedIn") setSteamReady(true);
  }, [steam]);

  useEffect(() => {
    void api.takeDataNotice().then((notice) => {
      if (notice) toast.warning("Your mods and settings couldn't be read", { description: notice, duration: Infinity });
    });
    void api.interfaceReady().catch(() => {});
  }, []);

  useEffect(() => {
    if (!steamReady || !steam) return;
    const lost = steam !== "signedIn";
    if (lost === steamLost.current) return;
    steamLost.current = lost;
    toast.dismiss(STEAM_TOAST);
    if (lost) {
      toast.warning(steam === "notRunning" ? "Steam closed" : "Signed out of Steam", {
        id: STEAM_TOAST,
        description: "You can keep working. Publishing to the Workshop waits until Steam is back.",
        action: { label: "Start Steam", onClick: openSteam },
        duration: Infinity,
      });
    } else {
      toast.success("Steam is back", { description: "Publishing to the Workshop is available again." });
    }
  }, [steam, steamReady]);

  function selectTool(id: ToolId) {
    setTool(id);
    setOpened((current) => (current.has(id) ? current : new Set(current).add(id)));
    localStorage.setItem(TOOL_KEY, id);
  }

  function closeSettings() {
    setSettingsOpen(false);
    setSettingsDirty(false);
  }

  /** Closes settings, checking first if that would throw away edits. */
  function requestCloseSettings() {
    if (settingsDirty) setConfirmDiscard(true);
    else closeSettings();
  }

  // Ctrl+1, Ctrl+2… jump between tools, in the order they're shown in the sidebar.
  useEffect(() => {
    if (settingsOpen || !steamReady) return;
    const onKey = (e: KeyboardEvent) => {
      // Not behind a dialog, where switching tools would change what's underneath it.
      if (!e.ctrlKey || e.shiftKey || e.altKey || dialogOpen()) return;
      // The key's position, so the number row works on any keyboard layout.
      const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
      const index = digit ? Number(digit[1]) - 1 : -1;
      if (TOOLS[index]) {
        e.preventDefault();
        selectTool(TOOLS[index].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen, steamReady]);

  const setBuildBusy = useCallback((value: boolean) => setBusy((b) => ({ ...b, build: value })), []);
  const setWorkshopBusy = useCallback((value: boolean) => setBusy((b) => ({ ...b, workshop: value })), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const settingsSaved = useCallback(() => setSettingsVersion((v) => v + 1), []);

  return (
    <TooltipProvider>
      <AppShell
        // The orange of the app's icon.
        mark={<AppMark className="size-3.5" />}
        markClassName="bg-brand/15 text-brand"
        // Until Steam is up there's nothing to choose between.
        sidebar={
          steamReady && (
            <AppSidebar
              sections={[{ label: "Tools", items: TOOLS.map((item) => ({ ...item, busy: busy[item.id] })) }]}
              active={tool}
              onSelect={selectTool}
              onOpenSettings={openSettings}
            />
          )
        }
      >
        {!steamReady ? (
          <SteamGate presence={steam} />
        ) : (
          <div className="flex min-w-0 flex-1">
            {/* Settings live with the build tool for now, since every setting is about building, so it stays mounted. */}
            <BuildTool
              active={tool === "build"}
              settingsOpen={settingsOpen}
              settingsVersion={settingsVersion}
              onOpenSettings={openSettings}
              onBusyChange={setBuildBusy}
            />
            {opened.has("workshop") && (
              <WorkshopTool
                active={tool === "workshop"}
                steamOnline={steam === "signedIn"}
                onBusyChange={setWorkshopBusy}
              />
            )}
          </div>
        )}
      </AppShell>

      <SettingsDialog
        open={settingsOpen}
        onRequestClose={requestCloseSettings}
        onSaved={settingsSaved}
        onDirtyChange={setSettingsDirty}
        theme={theme.preference}
        onThemeChange={theme.setPreference}
        scale={uiScale.scale}
        onScaleChange={uiScale.setScale}
      />

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your settings changes?</AlertDialogTitle>
            <AlertDialogDescription>They haven't been saved, so closing settings throws them away.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                closeSettings();
                setConfirmDiscard(false);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Toaster position="bottom-right" theme={theme.resolved} />
    </TooltipProvider>
  );
}
