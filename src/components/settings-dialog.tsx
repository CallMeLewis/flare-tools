import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  DownloadIcon,
  ExternalLinkIcon,
  InfoIcon,
  MonitorIcon,
  MoonIcon,
  PackageIcon,
  PaletteIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ScanSearchIcon,
  SunIcon,
  UserRoundIcon,
  WrenchIcon,
} from "lucide-react";
import { toast } from "sonner";

import { InstallUpdateDialog } from "@/components/install-update-dialog";
import { LicencesDialog } from "@/components/licences-dialog";
import { PathInput } from "@/components/path-input";
import { ReleaseNotesLink } from "@/components/release-notes";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useUpdateStatus } from "@/hooks/use-update-status";
import {
  api,
  errorMessage,
  steamUrl,
  type Settings,
  type SteamStatus,
  type UpdateChannel,
  type UpdateSettings,
  type UpdateStatus,
} from "@/lib/api";
import { openLink } from "@/lib/open";
import { releaseNoteItems, runningVersionNotes } from "@/lib/release-notes";
import type { ThemePreference } from "@/lib/theme";
import { UI_SCALES } from "@/lib/ui-scale";
import { cn } from "@/lib/utils";

type SectionId = "tools" | "defaults" | "steam" | "appearance" | "about";
type PathKey = keyof Settings;

interface PathField {
  key: PathKey;
  label: string;
  description: string;
  filters?: { name: string; extensions: string[] }[];
}

const TOOL_FIELDS: PathField[] = [
  {
    key: "pDrive",
    label: "P: drive",
    description: "The work drive pboProject packs from. Mods outside it are linked in for each build.",
  },
  {
    key: "pboProjectPath",
    label: "pboProject",
    description: "Mikero's pboProject.exe.",
    filters: [{ name: "pboProject", extensions: ["exe"] }],
  },
  {
    key: "dsSignFilePath",
    label: "DSSignFile",
    description: "Signs PBOs. It's in DayZ Tools under Bin\\DsUtils.",
    filters: [{ name: "DSSignFile", extensions: ["exe"] }],
  },
];

const DEFAULT_FIELDS: PathField[] = [
  {
    key: "defaultPrivateKeyPath",
    label: "Private key",
    description: "Signs mods that don't choose their own key. The matching .bikey must sit next to it.",
    filters: [{ name: "Private key", extensions: ["biprivatekey"] }],
  },
  {
    key: "defaultOutputRoot",
    label: "Output folder",
    description: "New mods are packed into an @Mod folder here.",
  },
];

const ALL_FIELDS = [...TOOL_FIELDS, ...DEFAULT_FIELDS];

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon; description: string; pinned?: boolean }[] = [
  { id: "tools", label: "Tools", icon: WrenchIcon, description: "Where DayZ Tools and pboProject live. Building needs all three." },
  {
    id: "defaults",
    label: "Build defaults",
    icon: PackageIcon,
    description: "Used by mods that don't set their own. Changing them doesn't touch existing mods' choices.",
  },
  { id: "steam", label: "Steam", icon: UserRoundIcon, description: "The account Workshop items are published from." },
  { id: "appearance", label: "Appearance", icon: PaletteIcon, description: "How the app looks. Changes apply straight away." },
  // Pinned to the bottom of the menu.
  { id: "about", label: "About", icon: InfoIcon, description: "Version, updates and who made the app.", pinned: true },
];

/** A raised surface on the content pane, matching the cards in the main window. */
const PANEL = "rounded-xl border bg-card text-card-foreground";

const AUTHOR = "CallMeLewis";
const REPO_URL = "https://github.com/CallMeLewis/flare-tools";

const THEMES: { id: ThemePreference; label: string; icon: LucideIcon; hint: string }[] = [
  { id: "system", label: "System", icon: MonitorIcon, hint: "Follows Windows" },
  { id: "light", label: "Light", icon: SunIcon, hint: "Always light" },
  { id: "dark", label: "Dark", icon: MoonIcon, hint: "Always dark" },
];

interface SettingsDialogProps {
  open: boolean;
  /** Asked when the user closes the dialog, so unsaved edits can be checked first. */
  onRequestClose: () => void;
  /** Called after a save, so whatever reads settings can pick up the new ones. */
  onSaved: () => void;
  /** Whether there are edits that haven't been saved, so leaving can check first. */
  onDirtyChange: (dirty: boolean) => void;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  /** Interface zoom, 1 being 100%. */
  scale: number;
  onScaleChange: (scale: number) => void;
}

/** Settings in a dialog, with its sections down the left. */
export function SettingsDialog({ open, onRequestClose, ...props }: SettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onRequestClose()}>
      <DialogContent className="flex h-[min(640px,calc(100vh-4rem))] gap-0 overflow-hidden p-0 sm:max-w-4xl">
        {/* Mounted only while open, so every visit starts from the saved settings. */}
        {open && <SettingsBody {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function SettingsBody({
  onSaved,
  onDirtyChange,
  theme,
  onThemeChange,
  scale,
  onScaleChange,
}: Omit<SettingsDialogProps, "open" | "onRequestClose">) {
  const [section, setSection] = useState<SectionId>("tools");
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [exists, setExists] = useState<Partial<Record<PathKey, boolean>>>({});
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    void api.getData().then(({ settings }) => {
      setSaved(settings);
      setDraft(settings);
    });
  }, []);

  const dirty = Boolean(saved && draft && ALL_FIELDS.some(({ key }) => saved[key] !== draft[key]));
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  useEffect(() => {
    if (!draft) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const entries = await Promise.all(ALL_FIELDS.map(async ({ key }) => [key, await api.pathExists(draft[key])] as const));
      if (!cancelled) setExists(Object.fromEntries(entries));
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [draft]);

  // A path that's set but can't be found, or a tool that isn't set at all, gets a dot in the menu.
  const fieldBroken = (key: PathKey) => Boolean(draft?.[key]) && exists[key] === false;
  const attention: Partial<Record<SectionId, boolean>> = {
    tools: TOOL_FIELDS.some(({ key }) => !draft?.[key] || fieldBroken(key)),
    defaults: DEFAULT_FIELDS.some(({ key }) => fieldBroken(key)),
  };

  async function detect() {
    if (!draft) return;
    const found = await api.detectTools();
    const next = { ...draft };
    let filled = 0;
    for (const { key } of ALL_FIELDS) {
      if (found[key] && found[key] !== draft[key]) {
        next[key] = found[key];
        filled++;
      }
    }
    setDraft(next);
    toast(filled ? "Filled in what was found" : "Nothing new was found", {
      description: filled ? "Check the paths, then save." : undefined,
    });
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const result = await api.saveSettings(draft);
      setSaved(result);
      setDraft(result);
      onSaved();
      toast.success("Settings saved");
    } catch (error) {
      toast.error("Couldn't save settings", { description: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  }

  const current = SECTIONS.find((s) => s.id === section)!;
  const editable = section === "tools" || section === "defaults";

  function renderFields(fields: PathField[]) {
    if (!draft) return null;
    return (
      <FieldGroup className="gap-6 p-4">
        {fields.map(({ key, label, description, filters }) => {
          const value = draft[key];
          const missing = fieldBroken(key);
          return (
            <Field key={key} data-invalid={missing || undefined}>
              <FieldLabel htmlFor={key} className="flex items-center gap-1.5">
                {label}
                {value && exists[key] && <CheckCircle2Icon className="size-3.5 text-success" aria-label="Found" />}
                {missing && <CircleAlertIcon className="size-3.5 text-destructive" aria-label="Not found" />}
              </FieldLabel>
              <PathInput
                id={key}
                value={value}
                onChange={(next) => setDraft((d) => d && { ...d, [key]: next })}
                filters={filters}
                invalid={missing}
                dialogTitle={`Choose ${label.toLowerCase()}`}
              />
              <FieldDescription>{missing ? "This path doesn't exist." : description}</FieldDescription>
            </Field>
          );
        })}
      </FieldGroup>
    );
  }

  return (
    <>
      <div className="flex w-52 shrink-0 flex-col border-r bg-sidebar p-3 text-sidebar-foreground">
        <div className="px-2 pt-2 pb-4">
          <DialogTitle className="text-base">Settings</DialogTitle>
          <DialogDescription className="mt-0.5 text-xs">Paths save with Save. The rest applies straight away.</DialogDescription>
        </div>
        <nav aria-label="Settings sections" className="flex flex-1 flex-col gap-0.5">
          {SECTIONS.map(({ id, label, icon: Icon, pinned }) => {
            const selected = id === section;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                aria-current={selected ? "page" : undefined}
                className={cn(
                  pinned && "mt-auto",
                  "flex h-9 w-full shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                  selected
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="flex-1 truncate">{label}</span>
                {attention[id] && (
                  <span className="size-2 shrink-0 rounded-full bg-destructive">
                    <span className="sr-only">(needs attention)</span>
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* The page background, like the main window, so the sections' cards stand out from it. */}
      <div className="flex min-w-0 flex-1 flex-col bg-background">
        {/* Room on the right for the dialog's close button. */}
        <header className="flex h-16 shrink-0 items-center gap-4 border-b pr-14 pl-6">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold">{current.label}</h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{current.description}</p>
          </div>
          {(editable || dirty) && (
            <div className="flex shrink-0 items-center gap-2">
              {dirty && <span className="mr-1 text-xs text-muted-foreground">Unsaved changes</span>}
              <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
                <AlertDialogTrigger render={<Button variant="outline" disabled={!dirty || saving} />}>
                  Discard
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Discard your settings changes?</AlertDialogTitle>
                    <AlertDialogDescription>They haven't been saved, so they'll be lost.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep editing</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => {
                        setConfirmDiscard(false);
                        if (saved) setDraft(saved);
                      }}
                    >
                      Discard
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <Button onClick={save} disabled={!dirty || saving} className="min-w-20">
                {saving && <Spinner data-icon="inline-start" />}
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {!draft ? (
            <div className="flex h-full items-center justify-center">
              <Spinner className="size-5 text-muted-foreground" />
            </div>
          ) : (
            <div className="flex flex-col gap-6 p-6">
              {section === "tools" && (
                <div className={cn(PANEL, "overflow-hidden")}>
                  {renderFields(TOOL_FIELDS)}
                  <div className="flex items-center gap-3 border-t bg-muted/50 px-4 py-3">
                    <p className="flex-1 text-xs text-muted-foreground">
                      Reads where pboProject and DayZ Tools are installed from the registry, and fills in anything
                      it finds.
                    </p>
                    <Button variant="outline" onClick={detect}>
                      <ScanSearchIcon data-icon="inline-start" />
                      Detect tools
                    </Button>
                  </div>
                </div>
              )}
              {section === "defaults" && <div className={PANEL}>{renderFields(DEFAULT_FIELDS)}</div>}
              {section === "steam" && <SteamSection />}
              {section === "appearance" && (
                <>
                  <ThemePicker value={theme} onChange={onThemeChange} />
                  <ScalePicker value={scale} onChange={onScaleChange} />
                </>
              )}
              {section === "about" && <AboutSection />}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function SteamSection() {
  const [steam, setSteam] = useState<SteamStatus | null>(null);
  const [checking, setChecking] = useState(false);

  async function check() {
    setChecking(true);
    try {
      setSteam(await api.steamStatus());
    } catch (error) {
      setSteam({ state: "unavailable", message: errorMessage(error) });
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    void check();
  }, []);

  if (!steam) {
    return (
      <p className={cn(PANEL, "flex items-center gap-2 p-4 text-sm text-muted-foreground")}>
        <Spinner className="size-4" />
        Connecting to Steam…
      </p>
    );
  }

  if (steam.state === "unavailable") {
    return (
      <div className={cn(PANEL, "flex items-start gap-3 p-4")}>
        <CircleAlertIcon className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Can't reach Steam</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{steam.message}</p>
        </div>
        <Button variant="outline" onClick={() => void check()} disabled={checking}>
          {checking ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className={cn(PANEL, "flex items-center gap-4 p-4")}>
        <span
          className="flex size-12 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-lg font-semibold text-sidebar-accent-foreground"
          aria-hidden
        >
          {steam.userName.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 truncate text-base font-semibold">
            {steam.userName}
            <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
              <span className="size-1.5 rounded-full bg-success" aria-hidden />
              Signed in
            </span>
          </p>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground select-text">{steam.steamId}</p>
        </div>
        <Button
          variant="outline"
          onClick={() => openLink(steamUrl(`https://steamcommunity.com/profiles/${steam.steamId}`))}
        >
          <ExternalLinkIcon data-icon="inline-start" />
          View profile
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        This is whoever is signed in to the Steam client. To publish from another account, switch accounts in Steam.
      </p>
    </div>
  );
}

function ThemePicker({ value, onChange }: { value: ThemePreference; onChange: (theme: ThemePreference) => void }) {
  return (
    <fieldset>
      <legend className="mb-3 text-sm font-medium">Theme</legend>
      <div className="grid grid-cols-3 gap-3">
        {THEMES.map(({ id, label, icon: Icon, hint }) => (
          <label
            key={id}
            className={cn(
              PANEL,
              "flex cursor-pointer flex-col items-center gap-2 p-4 text-center transition-colors has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
              // Tinted over the card rather than the page, so the chosen tile doesn't read darker than the others.
              value === id
                ? "border-primary bg-[color-mix(in_oklch,var(--primary)_5%,var(--card))]"
                : "hover:bg-muted/60",
            )}
          >
            <input
              type="radio"
              name="theme"
              value={id}
              checked={value === id}
              onChange={() => onChange(id)}
              className="sr-only"
            />
            <Icon className={cn("size-6", value === id ? "text-primary" : "text-muted-foreground")} aria-hidden />
            <span className="text-sm font-medium">{label}</span>
            <span className="text-xs text-muted-foreground">{hint}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ScalePicker({ value, onChange }: { value: number; onChange: (scale: number) => void }) {
  return (
    <div className={cn(PANEL, "flex items-center justify-between gap-6 p-4")}>
      <div className="min-w-0">
        <p id="ui-scale-label" className="text-sm font-medium">
          Interface size
        </p>
        <p id="ui-scale-description" className="mt-0.5 text-xs text-muted-foreground">
          Makes text and controls larger or smaller.
        </p>
      </div>
      {/* Every size on show, so the current one is clear and any other is one click away. */}
      <div
        role="radiogroup"
        aria-labelledby="ui-scale-label"
        aria-describedby="ui-scale-description"
        className="flex shrink-0 gap-0.5 rounded-lg border p-0.5"
      >
        {UI_SCALES.map((option) => (
          <label
            key={option}
            className={cn(
              "flex h-8 min-w-14 cursor-pointer items-center justify-center rounded-md px-2.5 font-mono text-xs transition-colors has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
              value === option
                ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <input
              type="radio"
              name="ui-scale"
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
              className="sr-only"
            />
            {Math.round(option * 100)}%
          </label>
        ))}
      </div>
    </div>
  );
}

const CHANNELS: { value: UpdateChannel; label: string }[] = [
  { value: "stable", label: "Stable" },
  { value: "beta", label: "Beta" },
];

/** The line under the version: plain unless there is an update to act on or something went wrong. */
function describeUpdate(status: UpdateStatus): string {
  switch (status.state) {
    case "unsupported":
      return "The version you're running. This copy can't update itself.";
    case "idle":
      return "The version you're running.";
    case "checking":
      return "Checking for updates…";
    case "upToDate": {
      const time = new Date(status.checkedAt).toLocaleTimeString(undefined, { timeStyle: "short" });
      return `You have the latest version. Last checked at ${time}.`;
    }
    case "available":
      return `Version ${status.version} is available.`;
    case "downloading":
      return `Downloading version ${status.version}… ${Math.floor(status.percent)}%`;
    case "ready":
      return `Version ${status.version} is ready to install. The app restarts to finish.`;
    case "error":
      return status.message;
  }
}

/**
 * The one button beside the version. It stays the same element as the update moves along, and is only marked
 * busy rather than disabled, so keyboard focus stays on it while it checks or downloads.
 */
function UpdateAction({ status, onRestart }: { status: UpdateStatus; onRestart: () => void }) {
  const busy = status.state === "checking" || status.state === "downloading";
  let icon = <RefreshCwIcon data-icon="inline-start" />;
  let text = "Check for updates";
  let action: () => void = () => void api.checkForUpdates();
  let primary = false;
  switch (status.state) {
    case "unsupported":
      return null;
    case "checking":
      icon = <Spinner data-icon="inline-start" />;
      text = "Checking…";
      break;
    case "upToDate":
      // Still checks again when clicked.
      icon = <CheckCircle2Icon data-icon="inline-start" />;
      text = "Up to date";
      break;
    case "error":
      text = "Try again";
      break;
    case "available":
      icon = <DownloadIcon data-icon="inline-start" />;
      text = `Download version ${status.version}`;
      action = () => void api.downloadUpdate();
      primary = true;
      break;
    case "downloading":
      icon = <Spinner data-icon="inline-start" />;
      text = "Downloading…";
      break;
    case "ready":
      icon = <RotateCcwIcon data-icon="inline-start" />;
      text = "Restart to update";
      action = onRestart;
      primary = true;
      break;
  }
  return (
    <Button
      variant={primary ? "default" : "outline"}
      className="aria-disabled:cursor-default aria-disabled:opacity-60"
      aria-disabled={busy || undefined}
      onClick={() => {
        if (!busy) action();
      }}
    >
      {icon}
      {text}
    </Button>
  );
}

function AboutSection() {
  const status = useUpdateStatus();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [updateSettings, setUpdateSettings] = useState<UpdateSettings | null>(null);
  const updateNotes = "notes" in status ? releaseNoteItems(status.notes) : [];
  const updateVersion = "version" in status ? status.version : undefined;

  useEffect(() => {
    // Without them the update options stay hidden, which is all a failure here could mean.
    api.updateSettings().then(setUpdateSettings, () => {});
  }, []);

  function openRepo() {
    api.openUrl(REPO_URL).catch((error) => toast.error("Couldn't open GitHub", { description: errorMessage(error) }));
  }

  function changeChannel(channel: UpdateChannel) {
    const previous = updateSettings;
    setUpdateSettings((current) => current && { ...current, channel });
    // Saving also checks the new channel; the result shows in the version row.
    api.setUpdateChannel(channel).catch((error) => {
      setUpdateSettings(previous);
      toast.error("Couldn't change the update channel", { description: errorMessage(error) });
    });
  }

  function changeAutoCheck(autoCheck: boolean) {
    const previous = updateSettings;
    setUpdateSettings((current) => current && { ...current, autoCheck });
    api.setAutoUpdateCheck(autoCheck).catch((error) => {
      setUpdateSettings(previous);
      toast.error("Couldn't save the setting", { description: errorMessage(error) });
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className={cn(PANEL, "flex items-center gap-4 p-4")}>
        <img src="/icon.svg" alt="" className="size-14 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold">Flare Tools</p>
          <p className="text-sm text-muted-foreground">Build, sign and publish DayZ mods.</p>
          <p className="mt-1 text-xs text-muted-foreground">Made by {AUTHOR}</p>
        </div>
        <Button variant="outline" className="shrink-0" onClick={openRepo}>
          <ExternalLinkIcon data-icon="inline-start" />
          View on GitHub
        </Button>
      </div>

      <div className={cn(PANEL, "divide-y")}>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-6">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
                Version
                <span className="font-mono text-xs font-normal text-muted-foreground select-text">{__APP_VERSION__}</span>
                {runningVersionNotes.length > 0 && (
                  <ReleaseNotesLink
                    appearance="chip"
                    version={__APP_VERSION__}
                    items={runningVersionNotes}
                    description="The changes in the version you're running."
                  />
                )}
              </p>
              <p
                className={cn("mt-0.5 text-xs", status.state === "error" ? "text-destructive" : "text-muted-foreground")}
                aria-live="polite"
              >
                {status.state === "error" && <CircleAlertIcon className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />}
                {describeUpdate(status)}
                {updateVersion && updateNotes.length > 0 && (
                  <>
                    {" "}
                    <ReleaseNotesLink
                      label="See what's new"
                      version={updateVersion}
                      items={updateNotes}
                      description="The changes in the update waiting for you."
                    />
                  </>
                )}
              </p>
            </div>
            <div className="shrink-0">
              <UpdateAction status={status} onRestart={() => setConfirmOpen(true)} />
              {status.state === "ready" && (
                <InstallUpdateDialog version={status.version} open={confirmOpen} onOpenChange={setConfirmOpen} />
              )}
            </div>
          </div>
          {status.state === "downloading" && (
            <Progress
              value={status.percent}
              className="**:data-[slot=progress-indicator]:duration-1000 **:data-[slot=progress-indicator]:ease-linear motion-reduce:**:data-[slot=progress-indicator]:transition-none"
              aria-label="Update download progress"
            />
          )}
        </div>

        <div className="flex items-center justify-between gap-6 p-4">
          <div className="min-w-0">
            <label htmlFor="auto-update-check" className="text-sm font-medium">
              Check for updates automatically
            </label>
            <p id="auto-update-check-description" className="mt-0.5 text-xs text-muted-foreground">
              When the app starts and every few hours. Nothing downloads until you choose to.
            </p>
          </div>
          <Switch
            id="auto-update-check"
            aria-describedby="auto-update-check-description"
            checked={updateSettings?.autoCheck ?? true}
            disabled={!updateSettings}
            onCheckedChange={changeAutoCheck}
          />
        </div>

        <div className="flex items-center justify-between gap-6 p-4">
          <div className="min-w-0">
            <p id="update-channel-label" className="text-sm font-medium">
              Update channel
            </p>
            <p id="update-channel-description" className="mt-0.5 text-xs text-muted-foreground">
              Stable releases, or beta builds with newer changes.
            </p>
          </div>
          <Select
            items={CHANNELS}
            value={updateSettings?.channel ?? null}
            disabled={!updateSettings}
            onValueChange={(channel) => channel && changeChannel(channel)}
          >
            <SelectTrigger
              aria-labelledby="update-channel-label"
              aria-describedby="update-channel-description"
              className="w-36 shrink-0"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {CHANNELS.map(({ value, label }) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className={cn(PANEL, "flex items-center justify-between gap-6 p-4")}>
        <div className="min-w-0">
          <p className="text-sm font-medium">Licences</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Free software under the GPL v3. It comes with no warranty.
          </p>
        </div>
        <LicencesDialog author={AUTHOR} repoUrl={REPO_URL} />
      </div>
    </div>
  );
}
