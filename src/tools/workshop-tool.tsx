import { useCallback, useEffect, useRef, useState } from "react";
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
} from "@flare/ui/ui/alert-dialog";
import { openSteam } from "@/components/steam-gate";
import { Button } from "@flare/ui/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { ToolPage, ToolPageTitle } from "@/components/tool-page";
import { ItemEditor } from "@/components/workshop/item-editor";
import { ItemList } from "@/components/workshop/item-list";
import {
  api,
  createdItemId,
  errorMessage,
  onPublishProgress,
  steamUrl,
  type ModConfig,
  type PublishProgress,
  type PublishRequest,
  type SteamStatus,
  type WorkshopItem,
} from "@/lib/api";
import { openLink } from "@/lib/open";
import { cn } from "@/lib/utils";

const SELECTED_KEY = "selectedWorkshopItem";
const NEW = "new";
/** How many times to look again for a new item that Steam hasn't listed yet, and how long to wait between. */
const LISTING_TRIES = 10;
const LISTING_WAIT_MS = 2000;
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
  // The key of the item being published ("new" while creating one), how far it's got, and whether it's sending
  // the page as edited, so leaving the page mid-save can say what's at stake.
  const [publishing, setPublishing] = useState<{
    key: string;
    progress: PublishProgress;
    sendsEdits: boolean;
  } | null>(null);
  // Whether the open editor has unsaved edits, and where the user asked to go while it did.
  const [dirty, setDirty] = useState(false);
  const [pendingId, setPendingId] = useState<string | null | undefined>(undefined);
  // The item Steam created for the new item's first publish before the rest of it failed. Publishing again
  // finishes that item, rather than leaving it empty and creating another.
  const [createdForNew, setCreatedForNew] = useState<string | null>(null);
  // A new item that's published but that Steam doesn't list yet. Its page opens once it does, rather than another's.
  const [listing, setListing] = useState<{ id: string; title: string; tries: number } | null>(null);

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

  const awaitingListing = listing !== null && selectedId === listing.id && !items?.some((i) => i.id === listing.id);
  const selected =
    selectedId === NEW || awaitingListing
      ? null
      : (items?.find((i) => i.id === selectedId) ?? items?.[0] ?? null);
  const showingNew = selectedId === NEW;

  useEffect(() => {
    if (!listing) return;
    if (items?.some((i) => i.id === listing.id)) {
      setListing(null);
      return;
    }
    if (listing.tries >= LISTING_TRIES) return;
    const timer = setTimeout(() => {
      void refresh().then(() => setListing((current) => current && { ...current, tries: current.tries + 1 }));
    }, LISTING_WAIT_MS);
    return () => clearTimeout(timer);
  }, [listing, items, refresh]);

  function select(id: string | null) {
    setSelectedId(id);
    // The editor remounts for the new item, so nothing is dirty until it says otherwise.
    setDirty(false);
    setCreatedForNew(null);
    setListing(null);
    if (id && id !== NEW) localStorage.setItem(SELECTED_KEY, id);
  }

  const editorKey = showingNew ? NEW : (selected?.id ?? null);
  // Read once a publish lands, to tell whether the user is still on the item it was for.
  const editorKeyRef = useRef(editorKey);
  editorKeyRef.current = editorKey;

  /** Moves to another item, checking first if that would throw away edits. */
  function requestSelect(id: string | null) {
    if (id === editorKey) return;
    if (dirty) setPendingId(id);
    else select(id);
  }

  /** Sends a page, files or both to Steam. Resolves to whether it was accepted. */
  async function publish(draft: PublishRequest): Promise<boolean> {
    const key = draft.itemId ?? NEW;
    const request = { ...draft, itemId: draft.itemId ?? createdForNew };
    const stage = !request.itemId ? "creating" : request.contentPath ? "preparing" : "committing";
    // An upload to an existing item sends the page as Steam has it, not the edits.
    const sendsEdits = !draft.itemId || !draft.contentPath;
    setPublishing({ key, progress: { itemId: request.itemId, stage, processed: 0, total: 0 }, sendsEdits });
    try {
      const outcome = await api.publishItem(request);
      await refresh();
      // A new item moves to its own page, unless the user has gone elsewhere in the meantime.
      if (key === NEW && editorKeyRef.current === NEW) {
        select(outcome.itemId);
        setListing({ id: outcome.itemId, title: request.title, tries: 0 });
      }
      if (outcome.needsAgreement) {
        toast.warning(`${request.title} is published, but hidden`, {
          description: "Steam won't show it until you accept the Workshop legal agreement.",
          action: { label: "Open agreement", onClick: () => openLink(AGREEMENT_URL) },
          duration: Infinity,
        });
      } else if (!request.itemId) {
        toast.success(`${request.title} published`);
      } else if (request.contentPath) {
        // While the user is still on the item, the upload dialog says it's done.
        if (editorKeyRef.current !== key) {
          toast.success(`${request.title} updated`, { description: "The new files are on Steam." });
        }
      } else {
        toast.success(`${request.title}'s page saved`);
      }
      return true;
    } catch (error) {
      const created = key === NEW ? createdItemId(error) : null;
      toast.error(`Couldn't publish ${request.title}`, {
        description: created
          ? `${errorMessage(error)} Steam had already created the item, so publishing again finishes it.`
          : errorMessage(error),
      });
      if (created && editorKeyRef.current === NEW) setCreatedForNew(created);
      // The item it created shows in the list.
      if (key === NEW) await refresh();
      return false;
    } finally {
      setPublishing(null);
    }
  }

  // Steam can be unreachable for a moment, such as while it restarts. An open editor stays, edits and all, and waits.
  const unreachable = steam?.state === "unavailable";
  const keepEditor = unreachable && editorKey !== null;

  const leavingName = showingNew ? "the new item" : (selected?.title || "this item");
  // The edits are on their way to Steam, so leaving only loses them if Steam turns them down.
  const leavingWhileSaving = publishing?.key === editorKey && publishing.sendsEdits;
  // As in the states below: something open shows once Steam has answered, even if it can't be reached.
  const showsEditor = Boolean(steam && editorKey);

  return (
    <div className={cn("flex min-w-0 flex-1 overflow-hidden", !active && "hidden")}>
      <ToolPage
        list={
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
        }
        notice={
          steam && (!steamOnline || keepEditor) && (
            <div
              role="status"
              className="flex shrink-0 items-center gap-3 border-b bg-warning/10 px-4 py-2.5 text-sm"
            >
              <UnplugIcon className="size-4 shrink-0 text-warning" aria-hidden />
              <p className="flex-1">
                {steamOnline ? "Can't reach Steam." : "Steam isn't connected."} You can keep editing; publishing waits
                until it's back.
              </p>
              {steamOnline ? (
                <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>
                  {refreshing && <Spinner data-icon="inline-start" />}
                  Try again
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={openSteam}>
                  Start Steam
                </Button>
              )}
            </div>
          )
        }
      >
        {/* The open item fills the header itself. Otherwise it names the tool. */}
        {!showsEditor && <ToolPageTitle title="Workshop" description="Publish your mods to the DayZ Workshop." />}
        {!steam ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        ) : unreachable && !keepEditor ? (
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
        ) : awaitingListing && listing.tries < LISTING_TRIES ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <Spinner className="size-5" />
            <p>Waiting for Steam to list {listing.title}…</p>
          </div>
        ) : awaitingListing ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UploadCloudIcon />
              </EmptyMedia>
              <EmptyTitle>{listing.title} is published</EmptyTitle>
              <EmptyDescription>Steam hasn't listed it yet. Refresh in a moment to open its page.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" onClick={() => void refresh()} disabled={refreshing}>
                {refreshing ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
                Refresh
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
            offline={!steamOnline || unreachable}
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
      </ToolPage>

      <AlertDialog open={pendingId !== undefined} onOpenChange={(open) => !open && setPendingId(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {leavingWhileSaving ? `Leave ${leavingName} while it's saving?` : `Discard changes to ${leavingName}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {leavingWhileSaving
                ? "Steam hasn't accepted the changes yet. If it turns them down, they'll be lost."
                : showingNew
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
              {leavingWhileSaving ? "Leave" : "Discard"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
