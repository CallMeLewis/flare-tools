import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BoxesIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { toast } from "sonner";

import { ModDialog } from "@/components/mod-dialog";
import { ModList } from "@/components/mod-list";
import { ModView } from "@/components/mod-view";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { useBuildSessions } from "@/hooks/use-build-sessions";
import { api, errorMessage, type AppData, type ModConfig, type ModStatus } from "@/lib/api";
import { modState, needsBuild } from "@/lib/mod-state";
import { dialogOpen } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

const SELECTED_KEY = "selectedModId";

interface BuildToolProps {
  /** False while another tool is showing. The tool stays mounted so builds and their logs carry on. */
  active: boolean;
  /** Settings sit over the tool while open, so its shortcuts stand down. */
  settingsOpen: boolean;
  /** Changes whenever settings are saved, so the tool reloads the ones it builds with. */
  settingsVersion: number;
  onOpenSettings: () => void;
  /** Lets the tool rail show that a build is running while another tool is open. */
  onBusyChange: (busy: boolean) => void;
}

export function BuildTool({ active, settingsOpen, settingsVersion, onOpenSettings, onBusyChange }: BuildToolProps) {
  const [data, setData] = useState<AppData | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ModStatus>>({});
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem(SELECTED_KEY));
  const [modDialog, setModDialog] = useState<{ open: boolean; mod: ModConfig | null }>({ open: false, mod: null });
  const [refreshKey, setRefreshKey] = useState(0);
  const { sessions, start, finish } = useBuildSessions();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  const refreshStatuses = useCallback(async () => {
    const list = await api.modStatuses();
    setStatuses(Object.fromEntries(list.map((s) => [s.id, s])));
  }, []);

  const reload = useCallback(async () => {
    setData(await api.getData());
    await refreshStatuses();
  }, [refreshStatuses]);

  useEffect(() => {
    void reload();
    setRefreshKey((k) => k + 1);
  }, [reload, settingsVersion]);

  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);

  // Pick up edits made outside the app when the window comes back into focus.
  useEffect(() => {
    const onFocus = () => {
      void refreshStatuses();
      setRefreshKey((k) => k + 1);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshStatuses]);

  const mods = data?.mods ?? [];
  const selected = mods.find((m) => m.id === selectedId) ?? mods[0] ?? null;
  // The open mod already shows its result, so toasts are only for builds happening out of view, which includes
  // every build while another tool is showing.
  const visibleIdRef = useRef<string | null>(null);
  visibleIdRef.current = active ? (selected?.id ?? null) : null;

  useEffect(() => {
    if (selected) localStorage.setItem(SELECTED_KEY, selected.id);
  }, [selected]);

  const buildMods = useCallback(
    async (ids: string[]) => {
      if (busyRef.current || ids.length === 0) return;
      busyRef.current = true;
      setBusy(true);
      try {
        for (const id of ids) {
          const name = mods.find((m) => m.id === id)?.name ?? "Mod";
          start(id);
          try {
            const outcome = await api.buildMod(id);
            finish(id, outcome);
            if (outcome.cancelled) break;
            if (id !== visibleIdRef.current) {
              if (outcome.ok) toast.success(`${name} built`);
              else toast.error(`${name} failed to build`, { description: outcome.error ?? undefined });
            }
          } catch (error) {
            finish(id, null, errorMessage(error));
            if (id !== visibleIdRef.current) {
              toast.error(`${name} failed to build`, { description: errorMessage(error) });
            }
          }
        }
      } finally {
        busyRef.current = false;
        setBusy(false);
        await reload();
        setRefreshKey((k) => k + 1);
      }
    },
    [mods, start, finish, reload],
  );

  const changedIds = useMemo(
    () => mods.filter((m) => needsBuild(modState(m, statuses[m.id], sessions[m.id]))).map((m) => m.id),
    [mods, statuses, sessions],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The key's position, so it's Ctrl+B on any keyboard layout.
      if (active && e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyB" && selected) {
        e.preventDefault();
        // Like the Build button: not behind a dialog, nor before the mod has been checked or when it can't be built.
        const status = statuses[selected.id];
        if (!settingsOpen && !modDialog.open && !dialogOpen() && status && !status.problem) {
          void buildMods([selected.id]);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, selected, buildMods, settingsOpen, modDialog.open, statuses]);

  async function changeMod(mod: ModConfig, patch: Partial<ModConfig>) {
    try {
      const saved = await api.saveMod({ ...mod, ...patch });
      setData((current) => current && { ...current, mods: current.mods.map((m) => (m.id === saved.id ? saved : m)) });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function removeMod(mod: ModConfig) {
    try {
      await api.removeMod(mod.id);
      setModDialog({ open: false, mod: null });
      await reload();
      toast(`${mod.name} removed`, { description: "Its files haven't been touched." });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  if (!data) {
    return (
      <div className={cn("flex flex-1 items-center justify-center", !active && "hidden")}>
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }

  const toolsMissing = !data.settings.pboProjectPath || !data.settings.pDrive;

  return (
    <>
      <div className={cn("flex min-w-0 flex-1 overflow-hidden", !active && "hidden")}>
        <ModList
          mods={mods}
          statuses={statuses}
          sessions={sessions}
          selectedId={selected?.id ?? null}
          onSelect={setSelectedId}
          onAdd={() => setModDialog({ open: true, mod: null })}
          changedCount={changedIds.length}
          busy={busy}
          onBuildChanged={() => void buildMods(changedIds)}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          {selected ? (
            <ModView
              key={selected.id}
              mod={selected}
              settings={data.settings}
              status={statuses[selected.id]}
              session={sessions[selected.id]}
              busy={busy}
              refreshKey={refreshKey}
              onBuild={() => void buildMods([selected.id])}
              onCancel={() => void api.cancelBuild()}
              onEdit={() => setModDialog({ open: true, mod: selected })}
              onChange={(patch) => void changeMod(selected, patch)}
            />
          ) : (
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <BoxesIcon />
                </EmptyMedia>
                <EmptyTitle>Add your first mod</EmptyTitle>
                <EmptyDescription>
                  Choose a mod's unpacked folder and where to pack it. After that, building is one click.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent className="flex-row justify-center">
                {toolsMissing && (
                  <Button variant="outline" onClick={onOpenSettings}>
                    <SettingsIcon data-icon="inline-start" />
                    Set up tools
                  </Button>
                )}
                <Button onClick={() => setModDialog({ open: true, mod: null })}>
                  <PlusIcon data-icon="inline-start" />
                  Add a mod
                </Button>
              </EmptyContent>
            </Empty>
          )}
        </main>
      </div>

      <ModDialog
        open={modDialog.open}
        onOpenChange={(open) => setModDialog((current) => ({ ...current, open }))}
        settings={data.settings}
        mod={modDialog.mod}
        onSaved={(saved) => {
          setSelectedId(saved.id);
          void reload();
          setRefreshKey((k) => k + 1);
        }}
        onRemove={modDialog.mod ? () => void removeMod(modDialog.mod!) : undefined}
      />
    </>
  );
}
