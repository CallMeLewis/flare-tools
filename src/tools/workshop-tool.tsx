import { useCallback, useEffect, useState } from "react";
import { PlusIcon, RefreshCwIcon, UnplugIcon, UploadCloudIcon } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { openSteam } from "@/components/steam-gate";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { ItemEditor } from "@/components/workshop/item-editor";
import { ItemList } from "@/components/workshop/item-list";
import {
  api,
  errorMessage,
  onPublishProgress,
  steamUrl,
  type ModConfig,
  type PublishProgress,
  type PublishRequest,
  type SteamStatus,
  type WorkshopItem,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const SELECTED_KEY = "selectedWorkshopItem";
const NEW = "new";
const AGREEMENT_URL = steamUrl("https://steamcommunity.com/sharedfiles/workshoplegalagreement");

interface WorkshopToolProps {
  active: boolean;
  /** Whether Steam is running and signed in. While it isn't, editing carries on and publishing waits. */
  steamOnline: boolean;
  onBusyChange: (busy: boolean) => void;
}

export function WorkshopTool({ active, steamOnline, onBusyChange }: WorkshopToolProps) {
  const [steam, setSteam] = useState<SteamStatus | null>(null);
  const [items, setItems] = useState<WorkshopItem[] | null>(null);
  const [mods, setMods] = useState<ModConfig[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem(SELECTED_KEY));
  const [refreshing, setRefreshing] = useState(false);
  // The key of the item being published ("new" while creating one) and how far it's got.
  const [publishing, setPublishing] = useState<{ key: string; progress: PublishProgress } | null>(null);
  // Whether the open editor has unsaved edits, and where the user asked to go while it did.
  const [dirty, setDirty] = useState(false);
  const [pendingId, setPendingId] = useState<string | null | undefined>(undefined);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const status = await api.steamStatus();
      setSteam(status);
      if (status.state === "ready") setItems(await api.workshopItems());
    } catch (error) {
      toast.error("Couldn't load your Workshop items", { description: errorMessage(error) });
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Loads on opening, and again when Steam comes back, since anything could have changed while it was away.
  // Not while it's away: a failed check would swap the editor out and lose its edits.
  useEffect(() => {
    if (steamOnline) void refresh();
  }, [refresh, steamOnline]);

  // The build tool's mods can change while this tool is hidden.
  useEffect(() => {
    if (active) void api.getData().then((data) => setMods(data.mods));
  }, [active]);

  useEffect(() => onBusyChange(publishing !== null), [publishing, onBusyChange]);

  useEffect(() => {
    const unlisten = onPublishProgress((progress) =>
      setPublishing((current) => current && { ...current, progress }),
    );
    return () => void unlisten.then((stop) => stop());
  }, []);

  const selected = selectedId === NEW ? null : (items?.find((i) => i.id === selectedId) ?? items?.[0] ?? null);
  const showingNew = selectedId === NEW;

  function select(id: string | null) {
    setSelectedId(id);
    // The editor remounts for the new item, so nothing is dirty until it says otherwise.
    setDirty(false);
    if (id && id !== NEW) localStorage.setItem(SELECTED_KEY, id);
  }

  const editorKey = showingNew ? NEW : (selected?.id ?? null);

  /** Moves to another item, checking first if that would throw away edits. */
  function requestSelect(id: string | null) {
    if (id === editorKey) return;
    if (dirty) setPendingId(id);
    else select(id);
  }

  /** Sends a page, files or both to Steam. Resolves to whether it was accepted. */
  async function publish(request: PublishRequest): Promise<boolean> {
    const key = request.itemId ?? NEW;
    const stage = !request.itemId ? "creating" : request.contentPath ? "preparing" : "committing";
    setPublishing({ key, progress: { itemId: request.itemId, stage, processed: 0, total: 0 } });
    try {
      const outcome = await api.publishItem(request);
      await refresh();
      select(outcome.itemId);
      if (outcome.needsAgreement) {
        toast.warning(`${request.title} is published, but hidden`, {
          description: "Steam won't show it until you accept the Workshop legal agreement.",
          action: { label: "Open agreement", onClick: () => void api.openUrl(AGREEMENT_URL) },
          duration: Infinity,
        });
      } else if (!request.itemId) {
        toast.success(`${request.title} published`);
      } else if (request.contentPath) {
        toast.success(`${request.title} updated`, { description: "The new files are on Steam." });
      } else {
        toast.success(`${request.title}'s page saved`);
      }
      return true;
    } catch (error) {
      toast.error(`Couldn't publish ${request.title}`, { description: errorMessage(error) });
      // Creating can succeed before the upload fails, which leaves an item behind to pick up.
      if (!request.itemId) await refresh();
      return false;
    } finally {
      setPublishing(null);
    }
  }

  const leavingName = showingNew ? "the new item" : (selected?.title || "this item");

  return (
    <div className={cn("flex min-w-0 flex-1 overflow-hidden", !active && "hidden")}>
      <ItemList
        steam={steam}
        items={items}
        selectedId={editorKey}
        onSelect={requestSelect}
        onNew={() => requestSelect(NEW)}
        onRefresh={() => void refresh()}
        refreshing={refreshing}
        offline={!steamOnline}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {!steamOnline && steam && (
          <div
            role="status"
            className="flex shrink-0 items-center gap-3 border-b bg-warning/10 px-6 py-2.5 text-sm"
          >
            <UnplugIcon className="size-4 shrink-0 text-warning" aria-hidden />
            <p className="flex-1">
              Steam isn't connected. You can keep editing; publishing waits until it's back.
            </p>
            <Button variant="outline" size="sm" onClick={openSteam}>
              Start Steam
            </Button>
          </div>
        )}
        {!steam ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        ) : steam.state === "unavailable" ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UploadCloudIcon />
              </EmptyMedia>
              <EmptyTitle>Can't reach Steam</EmptyTitle>
              <EmptyDescription>{steam.message}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" onClick={() => void refresh()} disabled={refreshing}>
                {refreshing ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
                Try again
              </Button>
            </EmptyContent>
          </Empty>
        ) : editorKey ? (
          <ItemEditor
            key={editorKey}
            item={showingNew ? null : selected}
            mods={mods}
            progress={publishing?.key === editorKey ? publishing.progress : null}
            busy={publishing !== null}
            offline={!steamOnline}
            onPublish={publish}
            onDiscardNew={() => requestSelect(items?.[0]?.id ?? null)}
            onDirtyChange={setDirty}
          />
        ) : items ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UploadCloudIcon />
              </EmptyMedia>
              <EmptyTitle>Publish your first mod</EmptyTitle>
              <EmptyDescription>
                Upload a packed @Mod folder to the DayZ Workshop. You can pick one straight from Build.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => requestSelect(NEW)}>
                <PlusIcon data-icon="inline-start" />
                New Workshop item
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        )}
      </main>

      <AlertDialog open={pendingId !== undefined} onOpenChange={(open) => !open && setPendingId(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes to {leavingName}?</AlertDialogTitle>
            <AlertDialogDescription>
              {showingNew
                ? "Nothing has been published yet, so the new item will be lost."
                : "The page edits haven't been saved, so leaving throws them away."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingId !== undefined) select(pendingId);
                setPendingId(undefined);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
