import { useEffect, useMemo, useState } from "react";
import { CircleAlertIcon, HammerIcon, UploadCloudIcon } from "lucide-react";

import { DisabledHint } from "@/components/disabled-hint";
import { PathInput } from "@/components/path-input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Counter } from "@/components/workshop/counter";
import { useContentSummary } from "@/hooks/use-content-summary";
import type { ModConfig, PublishProgress, PublishStage, WorkshopItem } from "@/lib/api";
import { fileSize, timeAgo } from "@/lib/format";
import { LIMITS, textBytes } from "@/lib/workshop";

export interface UploadRequest {
  contentPath: string;
  changeNote: string;
}

interface UploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The item getting new files, or null when publishing a new one. */
  item: WorkshopItem | null;
  /** What the item is called, for the dialog's title. */
  title: string;
  /** Mods from the build tool, offered as the files. */
  mods: ModConfig[];
  /** Progress while this item is being published. */
  progress: PublishProgress | null;
  /** Why uploading has to wait, such as another item publishing or Steam being away. */
  blockedReason: string | null;
  /** Whether the page has edits that haven't been saved, which the upload leaves alone. */
  pageDirty: boolean;
  onUpload: (request: UploadRequest) => void;
}

const STAGE_LABEL: Record<PublishStage, string> = {
  creating: "Creating the item",
  preparing: "Preparing",
  uploadingContent: "Uploading files",
  uploadingPreview: "Uploading preview",
  committing: "Saving on Steam",
};

/** Chooses the files for a new version (or a new item's first files) and sends them to Steam. */
export function UploadDialog({
  open,
  onOpenChange,
  item,
  title,
  mods,
  progress,
  blockedReason,
  pageDirty,
  onUpload,
}: UploadDialogProps) {
  const [contentPath, setContentPath] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const content = useContentSummary(contentPath);
  const isNew = !item;
  const publishing = Boolean(progress);

  // Start from the folder this item was last uploaded from.
  useEffect(() => {
    if (open) {
      setContentPath(item?.contentPath ?? "");
      setChangeNote("");
    }
  }, [open, item?.contentPath]);

  const builtBy = useMemo(
    () => mods.find((m) => m.outputPath.toLowerCase() === contentPath.trim().toLowerCase()) ?? null,
    [mods, contentPath],
  );

  const problems: string[] = [];
  if (!contentPath.trim()) problems.push("Choose the folder to upload.");
  else if (content && !content.exists) problems.push("The folder doesn't exist.");
  else if (content && content.fileCount === 0) problems.push("The folder is empty.");
  if (textBytes(changeNote) > LIMITS.changeNote) problems.push("The change note is too long.");

  const hint = publishing ? null : (blockedReason ?? (problems.length > 0 ? problems[0] : null));

  const percent = progress && progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : null;

  return (
    <Dialog
      open={open}
      // The upload can't be abandoned part way, so the dialog stays until Steam is done.
      onOpenChange={(next) => (next || !publishing) && onOpenChange(next)}
    >
      <DialogContent className="sm:max-w-2xl" showCloseButton={!publishing}>
        <DialogHeader>
          <DialogTitle>{isNew ? `Publish ${title}` : `Upload a new version of ${title}`}</DialogTitle>
          <DialogDescription>
            {isNew
              ? "The page is published along with these files."
              : "Steam only sends what's changed since the last upload, so unchanged files cost nothing."}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup className="gap-4">
          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel htmlFor="upload-path">Folder</FieldLabel>
              {mods.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="ghost" size="xs" disabled={publishing} />}>
                    <HammerIcon data-icon="inline-start" />
                    From Build
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>Upload a mod's output</DropdownMenuLabel>
                      {mods.map((mod) => (
                        <DropdownMenuItem key={mod.id} onClick={() => setContentPath(mod.outputPath)}>
                          <span className="truncate">{mod.name}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            <PathInput
              id="upload-path"
              value={contentPath}
              onChange={setContentPath}
              placeholder="The @Mod folder"
              dialogTitle="Choose the folder to upload"
              invalid={Boolean(content && !content.exists)}
            />
            <FieldDescription>
              {builtBy
                ? builtBy.lastBuild
                  ? `${builtBy.name}'s build output, last built ${timeAgo(builtBy.lastBuild.finishedAt)}${builtBy.lastBuild.ok ? "" : " (failed)"}.`
                  : `${builtBy.name}'s build output. It hasn't been built yet.`
                : "Everything in this folder is uploaded."}
            </FieldDescription>
          </Field>

          {content?.exists && (
            <div className="flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-xs select-text">
              <p className="font-medium tabular-nums">
                {content.fileCount.toLocaleString("en-GB")} {content.fileCount === 1 ? "file" : "files"} ·{" "}
                {fileSize(content.totalSize)}
              </p>
              {content.pbos.length > 0 && (
                <p className="text-muted-foreground">
                  <span className="text-foreground">
                    {content.pbos.length} PBO{content.pbos.length === 1 ? "" : "s"}
                  </span>{" "}
                  {content.pbos.join(", ")}
                </p>
              )}
              {content.keys.length > 0 && (
                <p className="text-muted-foreground">
                  <span className="text-foreground">Keys</span> {content.keys.join(", ")}
                </p>
              )}
              {content.hasModCpp && <p className="text-muted-foreground">mod.cpp</p>}
              {content.warnings.map((warning) => (
                <p key={warning} className="flex gap-1.5 text-warning">
                  <CircleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden />
                  {warning}
                </p>
              ))}
            </div>
          )}

          {!isNew && (
            <Field>
              <div className="flex items-center justify-between gap-2">
                <FieldLabel htmlFor="upload-note">Change note</FieldLabel>
                {changeNote.length > 0 && <Counter value={changeNote} max={LIMITS.changeNote} />}
              </div>
              <Textarea
                id="upload-note"
                value={changeNote}
                onChange={(e) => setChangeNote(e.target.value)}
                disabled={publishing}
                placeholder="What's new in this version"
                className="min-h-40"
              />
              <FieldDescription>Optional. Shown on the item's Change Notes tab.</FieldDescription>
            </Field>
          )}

          {progress ? (
            <div className="flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-sm" role="status">
              <p className="flex items-center justify-between gap-2 font-medium">
                <span className="flex items-center gap-2">
                  <Spinner className="size-3.5" />
                  {STAGE_LABEL[progress.stage]}
                </span>
                {percent !== null && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {fileSize(progress.processed)} of {fileSize(progress.total)}
                  </span>
                )}
              </p>
              <Progress value={percent} aria-label="Uploading" />
            </div>
          ) : (
            pageDirty &&
            !isNew && (
              <p className="flex gap-1.5 text-xs text-muted-foreground">
                <CircleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden />
                The page has unsaved edits. They stay in the editor, so save them separately.
              </p>
            )
          )}
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={publishing}>
            Cancel
          </Button>
          <DisabledHint reason={hint}>
            <Button
              onClick={() => onUpload({ contentPath: contentPath.trim(), changeNote: changeNote.trim() })}
              disabled={publishing || Boolean(blockedReason) || problems.length > 0}
            >
              {publishing ? <Spinner data-icon="inline-start" /> : <UploadCloudIcon data-icon="inline-start" />}
              {publishing ? (isNew ? "Publishing…" : "Uploading…") : isNew ? "Publish" : "Upload"}
            </Button>
          </DisabledHint>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
