import { useEffect, useState } from "react";
import {
  CheckIcon,
  CircleCheckIcon,
  CircleXIcon,
  FolderOpenIcon,
  HammerIcon,
  PencilIcon,
  InfoIcon,
  MinusIcon,
  SquareIcon,
  TerminalIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";

import { BuildLog, BuildSteps, CopyLogButton } from "@/components/build-output";
import { DisabledHint } from "@/components/disabled-hint";
import { ModPlan, prefixSourceLabel } from "@/components/mod-plan";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldContent, FieldDescription, FieldTitle } from "@/components/ui/field";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { BuildSession } from "@/hooks/use-build-sessions";
import { useBuildHistory, useSavedBuild } from "@/hooks/use-build-history";
import { useInspection } from "@/hooks/use-inspection";
import { api, type BuildRecord, type ModConfig, type ModStatus, type Settings } from "@/lib/api";
import { dateTime, fileName, fileSize, seconds } from "@/lib/format";
import { modState, STATE_DOT, stateLabel } from "@/lib/mod-state";
import { cn } from "@/lib/utils";

interface ModViewProps {
  mod: ModConfig;
  settings: Settings;
  status: ModStatus | undefined;
  session: BuildSession | undefined;
  /** True while any mod is building, since pboProject can only run one build at a time. */
  busy: boolean;
  /** Changes whenever the inspection should be redone, e.g. after a build. */
  refreshKey: number;
  onBuild: () => void;
  onCancel: () => void;
  onEdit: () => void;
  onChange: (patch: Partial<ModConfig>) => void;
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_1fr] items-baseline gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5">{children}</dd>
    </div>
  );
}

function recordTitle(record: BuildRecord): string {
  if (record.ok) return `Built in ${seconds(record.durationMs)}${record.signed ? ", signed" : ""}`;
  if (record.cancelled) return "Cancelled";
  return record.error ?? "Failed";
}

function RecordIcon({ record }: { record: BuildRecord }) {
  if (record.ok) return <CheckIcon className="size-3.5 text-success" aria-hidden />;
  if (record.cancelled) return <MinusIcon className="size-3.5 text-muted-foreground" aria-hidden />;
  return <XIcon className="size-3.5 text-destructive" aria-hidden />;
}

/** Where a value came from, shown on hover rather than taking up a line. */
function SourceHint({ text, warning }: { text: string; warning?: boolean }) {
  const Icon = warning ? TriangleAlertIcon : InfoIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={text}
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              warning ? "text-warning" : "text-muted-foreground hover:text-foreground",
            )}
          />
        }
      >
        <Icon className="size-3.5" aria-hidden />
      </TooltipTrigger>
      <TooltipContent side="right">{text}</TooltipContent>
    </Tooltip>
  );
}

export function ModView({
  mod,
  settings,
  status,
  session,
  busy,
  refreshKey,
  onBuild,
  onCancel,
  onEdit,
  onChange,
}: ModViewProps) {
  const inspection = useInspection(mod.sourcePath, mod.prefix, mod.pboName, refreshKey);
  const state = modState(mod, status, session);
  const running = Boolean(session?.running);
  const blocked = !inspection || Boolean(inspection.problem);
  const keyName = fileName(mod.privateKeyPath || settings.defaultPrivateKeyPath).replace(/\.biprivatekey$/i, "");
  // An earlier build picked from the list, shown in place of the current one.
  const [viewingId, setViewingId] = useState<string | null>(null);
  const history = useBuildHistory(mod.id, refreshKey);
  const viewing = history.find((r) => r.id === viewingId) ?? null;
  const saved = useSavedBuild(mod.id, viewing);
  // A new build always takes the view back.
  useEffect(() => {
    if (running) setViewingId(null);
  }, [running]);
  const shown = viewing ? saved : session;
  const shownOutcome = shown?.outcome;
  // mod.cpp is what gets copied into the @mod folder, so it wins when the two files disagree.
  const version = inspection?.modCpp?.version ?? inspection?.cfgMods?.version ?? null;
  const versionSource = inspection?.modCpp?.version ? "mod.cpp" : "config.cpp";
  const otherVersion =
    inspection?.modCpp?.version && inspection.cfgMods?.version && inspection.modCpp.version !== inspection.cfgMods.version
      ? inspection.cfgMods.version
      : null;
  const author = inspection?.modCpp?.author ?? inspection?.cfgMods?.author ?? null;
  const buildHint = running
    ? null
    : busy
      ? "Another mod is building. pboProject runs one build at a time."
      : !inspection
        ? "Checking the source folder…"
        : inspection.pbos.length === 0
          ? "Nothing to pack. The source folder has no PBOs in it."
          : blocked
            ? "Fix the problem under Packing first."
            : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-16 shrink-0 items-center gap-4 border-b px-6">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <h1 className="truncate text-base font-semibold" title={mod.name}>
              {mod.name}
            </h1>
            <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground">
              <span className={cn("size-1.5 rounded-full", STATE_DOT[state])} aria-hidden />
              {stateLabel(state, mod)}
            </Badge>
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground select-text" title={mod.sourcePath}>
            {mod.sourcePath}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" onClick={() => void api.openFolder(mod.outputPath)}>
            <FolderOpenIcon data-icon="inline-start" />
            Open output
          </Button>
          <DisabledHint reason={running ? "The mod can be edited once its build finishes." : null}>
            <Button variant="outline" onClick={onEdit} disabled={running}>
              <PencilIcon data-icon="inline-start" />
              Edit
            </Button>
          </DisabledHint>
          {/* Cancel sits beside Build rather than replacing it, so a double-click on Build
              can't land on Cancel. */}
          {running && (
            <Button variant="destructive" onClick={onCancel}>
              <SquareIcon data-icon="inline-start" />
              Cancel
            </Button>
          )}
          <DisabledHint reason={buildHint}>
            <Button onClick={onBuild} disabled={busy || blocked} className="min-w-28">
              {running ? <Spinner data-icon="inline-start" /> : <HammerIcon data-icon="inline-start" />}
              {running ? "Building…" : "Build"}
              {!running && <Kbd className="ml-1 bg-primary-foreground/10 text-primary-foreground/70">Ctrl B</Kbd>}
            </Button>
          </DisabledHint>
        </div>
      </header>

      {/* The packing column grows with the window but stops at 28rem, and never squeezes the log below
          a readable width at the minimum window size. */}
      <div className="grid min-h-0 flex-1 grid-cols-[clamp(18rem,34%,28rem)_minmax(0,1fr)] gap-4 p-4">
        {/* Packing takes what it needs and scrolls past a point; the build list fills the rest. */}
        <div className="flex min-h-0 flex-col gap-4">
          <Card className="max-h-[calc(100%-13rem)] shrink-0 overflow-y-auto">
            <CardHeader>
              <CardTitle>Packing</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <dl className="flex flex-col gap-2">
                {version && (
                  <Detail label="Version">
                    <span className="select-text">{version}</span>
                    <SourceHint
                      warning={Boolean(otherVersion)}
                      text={
                        otherVersion
                          ? `From ${versionSource}, but config.cpp says ${otherVersion}.`
                          : `From ${versionSource}.`
                      }
                    />
                  </Detail>
                )}
                {author && (
                  <Detail label="Author">
                    <span className="select-text">{author}</span>
                  </Detail>
                )}
                <Detail label="Prefix">
                  {inspection ? (
                    <>
                      <span className="min-w-0 truncate font-mono text-xs select-text" title={inspection.prefix}>
                        {inspection.prefix}
                      </span>
                      <SourceHint text={`Prefix ${prefixSourceLabel(inspection.prefixSource)}.`} />
                    </>
                  ) : (
                    <Spinner className="size-3.5" />
                  )}
                </Detail>
                <Detail label="Output">
                  <span className="block truncate font-mono text-xs select-text" title={mod.outputPath}>
                    {mod.outputPath}
                  </span>
                </Detail>
              </dl>

              {inspection && <ModPlan inspection={inspection} />}

              <div className="flex flex-col gap-4">
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>Binarise</FieldTitle>
                    <FieldDescription>config.cpp → config.bin</FieldDescription>
                  </FieldContent>
                  <Switch
                    checked={mod.binarise}
                    disabled={running}
                    onCheckedChange={(binarise) => onChange({ binarise })}
                    aria-label="Binarise"
                  />
                </Field>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>Convert PNGs</FieldTitle>
                    <FieldDescription>PNG → PAA</FieldDescription>
                  </FieldContent>
                  <Switch
                    checked={mod.convertPng}
                    disabled={running}
                    onCheckedChange={(convertPng) => onChange({ convertPng })}
                    aria-label="Convert PNGs"
                  />
                </Field>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>Sign</FieldTitle>
                    <FieldDescription>{keyName ? `With ${keyName}` : "No private key set"}</FieldDescription>
                  </FieldContent>
                  <Switch
                    checked={mod.sign}
                    disabled={running}
                    onCheckedChange={(sign) => onChange({ sign })}
                    aria-label="Sign"
                  />
                </Field>
                {inspection?.hasModCpp && (
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>Copy mod.cpp</FieldTitle>
                    </FieldContent>
                    <Switch
                      checked={mod.copyModCpp}
                      disabled={running}
                      onCheckedChange={(copyModCpp) => onChange({ copyModCpp })}
                      aria-label="Copy mod.cpp"
                    />
                  </Field>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader>
              <CardTitle>Previous builds</CardTitle>
            </CardHeader>
            <CardContent className="min-h-0 flex-1 overflow-y-auto">
              {history.length === 0 ? (
                <p className="text-xs text-muted-foreground">Each build is kept here, with its log, once there's been one.</p>
              ) : (
                <ul className="flex flex-col gap-0.5" aria-label="Previous builds">
                  {history.map((record) => {
                    const selected = record.id === viewingId;
                    return (
                      <li key={record.id}>
                        <button
                          type="button"
                          onClick={() => setViewingId(selected ? null : record.id)}
                          aria-pressed={selected}
                          className={cn(
                            "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                            selected ? "bg-muted" : "hover:bg-muted/60",
                          )}
                        >
                          <span className="flex size-4 shrink-0 items-center justify-center">
                            <RecordIcon record={record} />
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate" title={recordTitle(record)}>
                              {recordTitle(record)}
                            </span>
                            <span className="truncate text-xs text-muted-foreground tabular-nums">
                              {dateTime(record.finishedAt)}
                              {record.pbos.length > 0 && ` · ${record.pbos.length} PBO${record.pbos.length === 1 ? "" : "s"}`}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="flex min-h-0 flex-col">
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <CardTitle>Build output</CardTitle>
            {shown && (
              <div className="flex items-center gap-2">
                {viewing && (
                  <Button variant="ghost" size="xs" onClick={() => setViewingId(null)}>
                    <XIcon data-icon="inline-start" />
                    {dateTime(viewing.finishedAt)}
                  </Button>
                )}
                <BuildSteps session={shown} />
                <CopyLogButton session={shown} />
              </div>
            )}
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
            {viewing && !shown ? (
              <div className="flex flex-1 items-center justify-center">
                <Spinner className="size-5 text-muted-foreground" />
              </div>
            ) : shown ? (
              <>
                <BuildLog session={shown} />
                {shownOutcome && (
                  <div
                    className={cn(
                      "flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-sm tabular-nums",
                      shownOutcome.ok ? "border-success/30 bg-success/5" : "border-destructive/30 bg-destructive/5",
                    )}
                  >
                    <p className="flex items-center gap-2 font-medium">
                      {shownOutcome.ok ? (
                        <CircleCheckIcon className="size-4 text-success" />
                      ) : (
                        <CircleXIcon className="size-4 text-destructive" />
                      )}
                      {shownOutcome.ok
                        ? `Built in ${seconds(shownOutcome.durationMs)}${shownOutcome.signed ? " and signed" : ""}`
                        : shownOutcome.cancelled
                          ? "Build cancelled"
                          : (shownOutcome.error ?? "Build failed")}
                    </p>
                    {shownOutcome.pbos.length > 0 && (
                      <ul className="flex flex-col gap-1 text-xs text-muted-foreground select-text">
                        {shownOutcome.pbos.map((pbo) => (
                          <li key={pbo.path} className="flex gap-2">
                            <span className="text-foreground">{pbo.name}.pbo</span>
                            <span>{fileSize(pbo.size)}</span>
                            {pbo.signed && <span>· signed</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </>
            ) : (
              <Empty className="flex-1 border border-dashed">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <TerminalIcon />
                  </EmptyMedia>
                  <EmptyTitle>{status?.problem ? "Can't build yet" : "Ready to build"}</EmptyTitle>
                  <EmptyDescription>
                    {status?.problem
                      ? "Sort out the problem under Packing, then build."
                      : mod.lastBuild
                      ? `Last built ${dateTime(mod.lastBuild.finishedAt)}${mod.lastBuild.ok ? "" : " (failed)"}. pboProject's output shows here while it runs.`
                      : "pboProject's output shows here while it runs."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
