import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  CheckIcon,
  ExternalLinkIcon,
  ImageUpIcon,
  RotateCcwIcon,
  SaveIcon,
  UploadCloudIcon,
} from "lucide-react";

import { DisabledHint } from "@/components/disabled-hint";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import { BBCodeEditor } from "@/components/workshop/bbcode-editor";
import { Counter } from "@/components/workshop/counter";
import { Thumbnail } from "@/components/workshop/item-list";
import { TrendChart } from "@/components/workshop/trend-chart";
import { UploadDialog, type UploadRequest } from "@/components/workshop/upload-dialog";
import {
  api,
  workshopUrl,
  type ItemStats,
  type ModConfig,
  type PublishProgress,
  type PublishRequest,
  type StatSnapshot,
  type Visibility,
  type WorkshopItem,
} from "@/lib/api";
import { compactNumber, fileSize, shortDate, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { LIMITS, TAG_GROUPS, textBytes, VISIBILITY_DESCRIPTION, VISIBILITY_LABEL } from "@/lib/workshop";

interface ItemEditorProps {
  /** Null while writing a new item. */
  item: WorkshopItem | null;
  /** Mods from the build tool, offered as the item's files. */
  mods: ModConfig[];
  /** Progress while this item is being published. */
  progress: PublishProgress | null;
  /** True while any item is being published, since Steam uploads one at a time. */
  busy: boolean;
  /** Steam has gone away. The page can still be edited, but nothing can be sent until it's back. */
  offline: boolean;
  /** Resolves to whether Steam accepted the update. */
  onPublish: (request: PublishRequest) => Promise<boolean>;
  onDiscardNew: () => void;
  /** Whether the page has edits that would be lost by leaving it. */
  onDirtyChange: (dirty: boolean) => void;
}

/** The Workshop page: everything about the item except its files. */
interface Page {
  title: string;
  description: string;
  tags: string[];
  visibility: Visibility;
  /** A new preview image picked from disk, or empty to keep the current one. */
  previewPath: string;
}

const VISIBILITIES: Visibility[] = ["public", "friendsOnly", "unlisted", "private"];

function pageFor(item: WorkshopItem | null): Page {
  return {
    title: item?.title ?? "",
    description: item?.description ?? "",
    tags: item?.tags ?? ["Mod"],
    visibility: item?.visibility ?? "private",
    previewPath: "",
  };
}

interface Delta {
  value: number;
  /** When the figure it's compared with was recorded. */
  since: number;
}

/** The change since about a week ago, or since recording began if that's more recent. */
function deltaSince(history: StatSnapshot[], key: keyof ItemStats): Delta | null {
  if (history.length < 2) return null;
  const latest = history[history.length - 1];
  const weekAgo = latest.at - 7 * 86_400_000;
  const base = [...history].reverse().find((s) => s.at <= weekAgo) ?? history[0];
  if (base === latest) return null;
  return { value: latest.stats[key] - base.stats[key], since: base.at };
}

/** One of Steam's running totals, shortened, with the exact figure on hover. */
function StatTile({
  label,
  value,
  exact,
  detail,
  delta,
}: {
  label: string;
  value: string;
  exact?: string;
  detail?: string;
  delta?: Delta | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-lg font-semibold" title={exact}>
        {value}
      </span>
      {delta ? (
        <span
          className={cn(
            "truncate text-xs tabular-nums",
            delta.value > 0 ? "text-success" : delta.value < 0 ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {delta.value > 0 ? "+" : ""}
          {compactNumber(delta.value)} since {shortDate(delta.since)}
        </span>
      ) : (
        detail && <span className="truncate text-xs text-muted-foreground">{detail}</span>
      )}
    </div>
  );
}

const TREND_METRICS: { key: keyof ItemStats; label: string }[] = [
  { key: "subscriptions", label: "Subscribers" },
  { key: "favorites", label: "Favourites" },
  { key: "followers", label: "Followers" },
  { key: "uniqueWebsiteViews", label: "Views" },
];

function sameTags(a: string[], b: string[]) {
  return a.length === b.length && a.every((t) => b.includes(t));
}

/** Shows a picked image from disk, which the webview can't load by path. */
function useLocalImage(path: string) {
  const [image, setImage] = useState<{ url: string; size: number } | null>(null);
  useEffect(() => {
    if (!path) return setImage(null);
    let url = "";
    let cancelled = false;
    api
      .readFile(path)
      .then((bytes) => {
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([bytes]));
        setImage({ url, size: bytes.byteLength });
      })
      .catch(() => !cancelled && setImage(null));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);
  return image;
}

export function ItemEditor({
  item,
  mods,
  progress,
  busy,
  offline,
  onPublish,
  onDiscardNew,
  onDirtyChange,
}: ItemEditorProps) {
  const [page, setPage] = useState<Page>(() => pageFor(item));
  const [saving, setSaving] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [trend, setTrend] = useState<keyof ItemStats>("subscriptions");
  const preview = useLocalImage(page.previewPath);
  const isNew = !item;
  const publishing = Boolean(progress);
  // Inputs are locked while anything about this item is on its way to Steam.
  const locked = publishing || saving;

  const pageChanged =
    !item ||
    page.title !== item.title ||
    page.description !== item.description ||
    page.visibility !== item.visibility ||
    !sameTags(page.tags, item.tags) ||
    Boolean(page.previewPath);
  const dirty = isNew ? Boolean(page.title.trim() || page.description.trim() || page.previewPath) : pageChanged;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // Set before saving the page, so the draft restarts from what Steam now has once it lands.
  const resetOnUpdate = useRef(false);

  // Still dirty while saving: the edits aren't safe until Steam has accepted them.
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  // Pick up Steam's copy when it changes, unless that would throw away edits that haven't been saved.
  // Keyed on the update time rather than the item so refreshing the list leaves edits alone.
  useEffect(() => {
    if (resetOnUpdate.current || !dirtyRef.current) setPage(pageFor(item));
    resetOnUpdate.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.timeUpdated]);

  const set = <K extends keyof Page>(key: K, value: Page[K]) => setPage((current) => ({ ...current, [key]: value }));
  const toggleTag = (tag: string, on: boolean) =>
    set("tags", on ? [...page.tags, tag] : page.tags.filter((t) => t !== tag));

  const builtBy = useMemo(
    () =>
      item?.contentPath
        ? (mods.find((m) => m.outputPath.toLowerCase() === item.contentPath!.toLowerCase()) ?? null)
        : null,
    [mods, item?.contentPath],
  );
  const builtSinceUpload = Boolean(
    item && builtBy?.lastBuild?.ok && builtBy.lastBuild.finishedAt > item.timeUpdated,
  );

  const problems: string[] = [];
  if (!page.title.trim()) problems.push("Give the item a title.");
  if (textBytes(page.title) > LIMITS.title) problems.push("The title is too long.");
  if (textBytes(page.description) > LIMITS.description) problems.push("The description is too long.");
  if (preview && preview.size > LIMITS.previewBytes) problems.push("The preview image is over 1 MB.");
  if (isNew && !page.previewPath) problems.push("Choose a preview image.");

  const problemList = (
    <ul className="flex flex-col gap-0.5">
      {problems.map((problem) => (
        <li key={problem}>{problem}</li>
      ))}
    </ul>
  );
  // Why sending is held up by something other than this page.
  const busyHint = publishing
    ? null
    : offline
      ? "Steam isn't connected. Publishing waits until it's back."
      : busy
        ? "Another item is publishing. Steam uploads one at a time."
        : null;
  const blocked = busy || offline;
  const saveHint = locked
    ? null
    : (busyHint ?? (problems.length > 0 ? problemList : !pageChanged ? "Nothing on the page has changed." : null));
  const publishHint = locked ? null : (busyHint ?? (problems.length > 0 ? problemList : null));

  async function choosePreview() {
    const picked = await open({
      title: "Choose a preview image",
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif"] }],
    });
    if (typeof picked === "string") set("previewPath", picked);
  }

  /** The page as it's being edited. */
  function draftPage(): Omit<PublishRequest, "contentPath" | "changeNote"> {
    return {
      itemId: item?.id ?? null,
      title: page.title.trim(),
      description: page.description,
      tags: page.tags,
      visibility: page.visibility,
      previewPath: page.previewPath || null,
    };
  }

  /** The page as Steam has it, so an upload doesn't quietly publish unsaved edits. */
  function savedPage(saved: WorkshopItem): Omit<PublishRequest, "contentPath" | "changeNote"> {
    return {
      itemId: saved.id,
      title: saved.title,
      description: saved.description,
      tags: saved.tags,
      visibility: saved.visibility,
      previewPath: null,
    };
  }

  async function savePage() {
    if (!item) return;
    setSaving(true);
    resetOnUpdate.current = true;
    try {
      const ok = await onPublish({ ...draftPage(), contentPath: null, changeNote: "" });
      if (ok) set("previewPath", "");
      else resetOnUpdate.current = false;
    } finally {
      setSaving(false);
    }
  }

  async function upload({ contentPath, changeNote }: UploadRequest) {
    const ok = await onPublish({ ...(item ? savedPage(item) : draftPage()), contentPath, changeNote });
    if (ok) setUploadOpen(false);
  }

  const title = page.title.trim() || (isNew ? "New item" : "Untitled");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-16 shrink-0 items-center gap-4 border-b px-6">
        <Thumbnail src={preview?.url ?? item?.previewUrl ?? null} className="size-9" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <h1 className="truncate text-lg font-semibold" title={title}>
              {title}
            </h1>
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {isNew ? "Not published" : VISIBILITY_LABEL[item.visibility]}
            </Badge>
            {builtSinceUpload && (
              <Badge variant="outline" className="gap-1.5 border-warning/30 font-normal text-warning">
                <span className="size-1.5 rounded-full bg-warning" aria-hidden />
                Built since last upload
              </Badge>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground tabular-nums">
            {item ? (
              <>
                Updated {timeAgo(item.timeUpdated)} · {fileSize(item.fileSize)} ·{" "}
                <span className="select-text" title="Workshop ID">
                  ID {item.id}
                </span>
              </>
            ) : (
              "Fill in the page, then publish it with the mod's files."
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {item ? (
            <Button variant="ghost" onClick={() => void api.openUrl(workshopUrl(item.id))}>
              <ExternalLinkIcon data-icon="inline-start" />
              View on Steam
            </Button>
          ) : (
            <Button variant="ghost" onClick={onDiscardNew} disabled={locked}>
              Discard
            </Button>
          )}
          {item && pageChanged && !locked && (
            <Button variant="outline" onClick={() => setPage(pageFor(item))}>
              <RotateCcwIcon data-icon="inline-start" />
              Undo changes
            </Button>
          )}
          {item ? (
            <>
              <DisabledHint reason={saveHint}>
                <Button
                  variant="outline"
                  onClick={() => void savePage()}
                  disabled={locked || blocked || !pageChanged || problems.length > 0}
                >
                  {saving ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
                  {saving ? "Saving…" : "Save page"}
                </Button>
              </DisabledHint>
              <DisabledHint reason={busyHint}>
                <Button size="lg" onClick={() => setUploadOpen(true)} disabled={locked || blocked} className="min-w-28">
                  <UploadCloudIcon data-icon="inline-start" />
                  Upload new version…
                </Button>
              </DisabledHint>
            </>
          ) : (
            <DisabledHint reason={publishHint}>
              <Button
                size="lg"
                onClick={() => setUploadOpen(true)}
                disabled={locked || blocked || problems.length > 0}
                className="min-w-28"
              >
                <UploadCloudIcon data-icon="inline-start" />
                Publish…
              </Button>
            </DisabledHint>
          )}
        </div>
      </header>

      {/* The page and the stats share the width, each scrolling on its own. When the window is too
          narrow for both, the stats drop below the page and the whole thing scrolls together. */}
      <div className="@container min-h-0 flex-1 overflow-y-auto @3xl:overflow-hidden">
        <div
          className={cn(
            "grid gap-4 p-4 @3xl:h-full @3xl:grid-rows-[minmax(0,1fr)]",
            item && "@3xl:grid-cols-[minmax(0,1fr)_clamp(24rem,50%,40rem)]",
          )}
        >
          <div className="flex flex-col @3xl:min-h-0 @3xl:overflow-y-auto">
            <Card>
              <CardHeader>
                <CardTitle>Workshop page</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                <div className="flex gap-4">
                  <div className="flex shrink-0 flex-col items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void choosePreview()}
                      disabled={locked}
                      aria-label="Choose a preview image"
                      className="group relative size-32 overflow-hidden rounded-lg border outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <Thumbnail src={preview?.url ?? item?.previewUrl ?? null} className="size-full rounded-none" />
                      <span className="absolute inset-0 flex items-center justify-center bg-overlay opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                        <ImageUpIcon className="size-5 text-overlay-foreground" aria-hidden />
                      </span>
                    </button>
                    <p
                      className={cn(
                        "w-32 text-center text-xs",
                        preview && preview.size > LIMITS.previewBytes ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {preview ? `New image, ${fileSize(preview.size)}` : "Square, under 1 MB"}
                    </p>
                  </div>

                  <div className="flex min-w-0 flex-1 flex-col gap-4">
                    <Field>
                      <div className="flex items-center justify-between gap-2">
                        <FieldLabel htmlFor="item-title">Title</FieldLabel>
                        <Counter value={page.title} max={LIMITS.title} />
                      </div>
                      <Input
                        id="item-title"
                        value={page.title}
                        onChange={(e) => set("title", e.target.value)}
                        disabled={locked}
                        aria-invalid={textBytes(page.title) > LIMITS.title || undefined}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="item-visibility">Visibility</FieldLabel>
                      <Select
                        value={page.visibility}
                        onValueChange={(value) => value && set("visibility", value as Visibility)}
                        disabled={locked}
                      >
                        <SelectTrigger id="item-visibility" className="w-full">
                          <SelectValue>{(value: Visibility) => VISIBILITY_LABEL[value]}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {VISIBILITIES.map((v) => (
                              <SelectItem key={v} value={v}>
                                {VISIBILITY_LABEL[v]}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <FieldDescription>{VISIBILITY_DESCRIPTION[page.visibility]}</FieldDescription>
                    </Field>
                  </div>
                </div>

                <fieldset className="flex flex-col gap-3">
                  <legend className="mb-3 text-sm font-medium">Tags</legend>
                  {TAG_GROUPS.map((group) => (
                    <div key={group.name} className="grid grid-cols-[5rem_1fr] items-baseline gap-3">
                      <span className="text-xs text-muted-foreground">{group.name}</span>
                      <div className="flex flex-wrap gap-1.5">
                        {group.tags.map((tag) => (
                          <Toggle
                            key={tag}
                            variant="outline"
                            size="sm"
                            pressed={page.tags.includes(tag)}
                            onPressedChange={(on) => toggleTag(tag, on)}
                            disabled={locked}
                            className="aria-pressed:border-transparent aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/85"
                          >
                            {page.tags.includes(tag) && <CheckIcon data-icon="inline-start" />}
                            {tag}
                          </Toggle>
                        ))}
                      </div>
                    </div>
                  ))}
                </fieldset>

                <BBCodeEditor
                  id="item-description"
                  label="Description"
                  value={page.description}
                  onChange={(description) => set("description", description)}
                  disabled={locked}
                  max={LIMITS.description}
                />
              </CardContent>
            </Card>
          </div>

          {item && (
            <div className="flex flex-col gap-4 @3xl:min-h-0 @3xl:overflow-y-auto">
              <Card>
                <CardHeader>
                  <CardTitle>Stats</CardTitle>
                </CardHeader>
                {/* As many tiles per row as fit, so nothing is squeezed into truncating. */}
                <CardContent className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-x-4 gap-y-4">
                  <StatTile
                    label="Subscribers"
                    value={compactNumber(item.stats.subscriptions)}
                    exact={`${item.stats.subscriptions.toLocaleString("en-GB")} (${item.stats.uniqueSubscriptions.toLocaleString("en-GB")} unique)`}
                    detail={
                      item.stats.uniqueSubscriptions !== item.stats.subscriptions
                        ? `${compactNumber(item.stats.uniqueSubscriptions)} unique`
                        : undefined
                    }
                    delta={deltaSince(item.history, "subscriptions")}
                  />
                  <StatTile
                    label="Favourites"
                    value={compactNumber(item.stats.favorites)}
                    exact={item.stats.favorites.toLocaleString("en-GB")}
                    delta={deltaSince(item.history, "favorites")}
                  />
                  <StatTile
                    label="Followers"
                    value={compactNumber(item.stats.followers)}
                    exact={item.stats.followers.toLocaleString("en-GB")}
                    delta={deltaSince(item.history, "followers")}
                  />
                  <StatTile
                    label="Page views"
                    value={compactNumber(item.stats.uniqueWebsiteViews)}
                    exact={`${item.stats.uniqueWebsiteViews.toLocaleString("en-GB")} unique visitors`}
                    delta={deltaSince(item.history, "uniqueWebsiteViews")}
                  />
                  <StatTile
                    label="Comments"
                    value={compactNumber(item.stats.comments)}
                    exact={item.stats.comments.toLocaleString("en-GB")}
                    delta={deltaSince(item.history, "comments")}
                  />
                  {(() => {
                    const votes = item.stats.upvotes + item.stats.downvotes;
                    return (
                      <StatTile
                        label="Rating"
                        value={votes > 0 ? `${Math.round((item.stats.upvotes / votes) * 100)}% positive` : "No votes yet"}
                        detail={
                          votes > 0
                            ? `${compactNumber(item.stats.upvotes)} up · ${compactNumber(item.stats.downvotes)} down`
                            : undefined
                        }
                      />
                    );
                  })()}
                  {item.stats.secondsPlayed > 0 && (
                    <StatTile
                      label="Playtime"
                      value={`${compactNumber(Math.round(item.stats.secondsPlayed / 3600))} h`}
                      exact={`${item.stats.secondsPlayed.toLocaleString("en-GB")} seconds`}
                      detail={`${compactNumber(item.stats.playtimeSessions)} sessions`}
                    />
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
                  <CardTitle>Trend</CardTitle>
                  <Tabs value={trend} onValueChange={(next) => setTrend(next as keyof ItemStats)}>
                    <TabsList className="h-7">
                      {TREND_METRICS.map((metric) => (
                        <TabsTrigger key={metric.key} value={metric.key} className="px-2 text-xs">
                          {metric.label}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                </CardHeader>
                <CardContent>
                  {item.history.length >= 2 ? (
                    <TrendChart
                      label={TREND_METRICS.find((m) => m.key === trend)?.label ?? trend}
                      points={item.history.map((s) => ({ at: s.at, value: s.stats[trend] }))}
                      format={compactNumber}
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Steam only gives today's figures, so the app records them each time this list refreshes. A trend
                      appears once there's more than one day on record.
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>

      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        item={item}
        title={title}
        mods={mods}
        progress={uploadOpen ? progress : null}
        blockedReason={busyHint}
        pageDirty={!isNew && pageChanged}
        onUpload={(request) => void upload(request)}
      />
    </div>
  );
}
