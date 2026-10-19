import { useEffect, useState } from "react";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  ExternalLinkIcon,
  InfoIcon,
  PackageIcon,
  PaletteIcon,
  RefreshCwIcon,
  ScanSearchIcon,
  UserRoundIcon,
  WrenchIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  AboutSection,
  AppearanceSettings,
  SettingRow,
  SettingsDialog as FlareSettingsDialog,
  SettingsGroup,
} from "@flare/ui";

import { DisabledHint } from "@/components/disabled-hint";
import { LicencesDialog } from "@/components/licences-dialog";
import { PathInput } from "@/components/path-input";
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
} from "@flare/ui/ui/alert-dialog";
import { Button } from "@flare/ui/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage, steamUrl, type Settings, type SteamStatus } from "@/lib/api";
import { openLink } from "@/lib/open";
import type { ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";

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

/** A raised surface on the content pane, as the shared settings groups are. */
const PANEL = "rounded-lg border bg-card text-card-foreground";

const AUTHOR = "CallMeLewis";
const REPO_URL = "https://github.com/CallMeLewis/flare-tools";

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

/**
 * Settings, in the dialog every Flare app shares. The paths to the tools and the build defaults are saved with a
 * button, since a half-typed path shouldn't change what the next build uses; everything else saves as it changes.
 */
export function SettingsDialog({
  open,
  onRequestClose,
  onSaved,
  onDirtyChange,
  theme,
  onThemeChange,
  scale,
  onScaleChange,
}: SettingsDialogProps) {
  const [section, setSection] = useState<string>("tools");
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [exists, setExists] = useState<Partial<Record<PathKey, boolean>>>({});
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Every visit starts from the saved settings, on the first section.
  useEffect(() => {
    if (!open) return;
    setSection("tools");
    setSaved(null);
    setDraft(null);
    void api.getData().then(({ settings }) => {
      setSaved(settings);
      setDraft(settings);
    });
  }, [open]);

  const dirty = Boolean(saved && draft && ALL_FIELDS.some(({ key }) => saved[key] !== draft[key]));
  useEffect(() => onDirtyChange(open && dirty), [open, dirty, onDirtyChange]);

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
  const toolsNeedAttention = Boolean(draft) && TOOL_FIELDS.some(({ key }) => !draft?.[key] || fieldBroken(key));
  const defaultsNeedAttention = DEFAULT_FIELDS.some(({ key }) => fieldBroken(key));

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

  function renderFields(fields: PathField[]) {
    if (!draft) {
      return (
        <div className="flex items-center justify-center p-8">
          <Spinner className="size-5 text-muted-foreground" />
        </div>
      );
    }
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

  const editable = section === "tools" || section === "defaults";

  return (
    <FlareSettingsDialog
      open={open}
      onOpenChange={(next) => !next && onRequestClose()}
      section={section}
      onSectionChange={setSection}
      sections={[
        {
          id: "tools",
          label: "Tools",
          icon: WrenchIcon,
          description: "Where DayZ Tools and pboProject live. Building needs all three.",
          attention: toolsNeedAttention,
          content: (
            <div className={cn(PANEL, "overflow-hidden")}>
              {renderFields(TOOL_FIELDS)}
              <div className="flex items-center gap-3 border-t bg-muted/50 px-4 py-3">
                <p className="flex-1 text-xs text-muted-foreground">
                  Reads where pboProject and DayZ Tools are installed from the registry, and fills in anything it finds.
                </p>
                <Button variant="outline" onClick={detect} disabled={!draft}>
                  <ScanSearchIcon data-icon="inline-start" />
                  Detect tools
                </Button>
              </div>
            </div>
          ),
        },
        {
          id: "defaults",
          label: "Build defaults",
          icon: PackageIcon,
          description: "Used by mods that don't set their own. Changing them doesn't touch existing mods' choices.",
          attention: defaultsNeedAttention,
          content: <div className={PANEL}>{renderFields(DEFAULT_FIELDS)}</div>,
        },
        {
          id: "steam",
          label: "Steam",
          icon: UserRoundIcon,
          description: "The account Workshop items are published from.",
          content: <SteamSection />,
        },
        {
          id: "appearance",
          label: "Appearance",
          icon: PaletteIcon,
          description: "How the app looks. Changes apply straight away.",
          content: (
            <AppearanceSettings theme={theme} onThemeChange={onThemeChange} scale={scale} onScaleChange={onScaleChange} />
          ),
        },
        {
          id: "about",
          label: "About",
          icon: InfoIcon,
          description: "Version, updates and who made the app.",
          pinned: true,
          content: <About />,
        },
      ]}
      // At the foot, where the fields above lead and away from the close button. On the sections with fields to
      // save, and on any other while there are changes waiting.
      footer={
        (editable || dirty) && (
          <>
            <p className="flex-1 text-xs text-muted-foreground" aria-live="polite">
              {dirty ? "Unsaved changes" : ""}
            </p>
            <DisabledHint reason={!dirty ? "Nothing has changed yet." : null}>
              <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" disabled={!dirty || saving}>
                    Discard
                  </Button>
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
            </DisabledHint>
            <DisabledHint reason={!dirty ? "Nothing has changed yet." : null}>
              <Button onClick={save} disabled={!dirty || saving} className="min-w-20">
                {saving && <Spinner data-icon="inline-start" />}
                {saving ? "Saving…" : "Save"}
              </Button>
            </DisabledHint>
          </>
        )
      }
    />
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

function About() {
  function openRepo() {
    api.openUrl(REPO_URL).catch((error) => toast.error("Couldn't open GitHub", { description: errorMessage(error) }));
  }

  return (
    <AboutSection icon="/icon.svg" tagline="Build, sign and publish DayZ mods." author={AUTHOR} onOpenProject={openRepo}>
      <SettingsGroup title="Licences">
        <SettingRow id="licences" label="Free software" description="Under the GPL v3. It comes with no warranty.">
          <LicencesDialog author={AUTHOR} repoUrl={REPO_URL} />
        </SettingRow>
      </SettingsGroup>
    </AboutSection>
  );
}
