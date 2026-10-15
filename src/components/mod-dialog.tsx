import { useEffect, useState } from "react";
import { toast } from "sonner";

import { DisabledHint } from "@/components/disabled-hint";
import { ModPlan, prefixSourceLabel } from "@/components/mod-plan";
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
} from "@/components/ui/alert-dialog";
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
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useInspection } from "@/hooks/use-inspection";
import { api, errorMessage, type ModConfig, type Settings } from "@/lib/api";
import { fileName, joinPath } from "@/lib/format";

interface ModDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings;
  /** The mod being edited, or null to add a new one. */
  mod: ModConfig | null;
  onSaved: (mod: ModConfig) => void;
  /** Removes the mod being edited from the list. */
  onRemove?: () => void;
}

/** Whether two versions of a mod differ in anything the dialog edits, counting a cleared field as unset. */
function sameMod(a: ModConfig, b: ModConfig) {
  return (Object.keys(a) as (keyof ModConfig)[]).every(
    (key) => key === "lastBuild" || (a[key] ?? "") === (b[key] ?? ""),
  );
}

function blankMod(): ModConfig {
  return {
    id: "",
    name: "",
    sourcePath: "",
    prefix: null,
    outputPath: "",
    pboName: null,
    binarise: true,
    sign: true,
    privateKeyPath: null,
    copyModCpp: true,
    convertPng: true,
    lastBuild: null,
  };
}

export function ModDialog({ open, onOpenChange, settings, mod, onSaved, onRemove }: ModDialogProps) {
  const [draft, setDraft] = useState<ModConfig>(blankMod);
  // Name and output follow the source folder until they're edited by hand.
  const [nameTouched, setNameTouched] = useState(false);
  const [outputTouched, setOutputTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  // Asking whether to throw away edits, after the user tried to close the dialog.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const inspection = useInspection(draft.sourcePath, draft.prefix, draft.pboName);
  const editing = Boolean(mod);
  const dirty = !sameMod(draft, mod ?? blankMod());

  /** Closes the dialog, checking first if that would throw away edits. */
  function requestClose() {
    if (dirty && !saving) setConfirmDiscard(true);
    else onOpenChange(false);
  }

  useEffect(() => {
    if (!open) return;
    setDraft(mod ?? blankMod());
    setNameTouched(Boolean(mod));
    setOutputTouched(Boolean(mod));
  }, [open, mod]);

  function update(patch: Partial<ModConfig>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function changeSource(sourcePath: string) {
    const folder = fileName(sourcePath);
    setDraft((current) => ({
      ...current,
      sourcePath,
      name: nameTouched ? current.name : folder,
      outputPath:
        outputTouched || !folder ? current.outputPath : joinPath(settings.defaultOutputRoot, `@${folder}`),
    }));
  }

  async function save() {
    setSaving(true);
    try {
      onSaved(await api.saveMod(draft));
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const singlePbo = inspection?.pbos.length === 1;
  const keyName = fileName(draft.privateKeyPath || settings.defaultPrivateKeyPath).replace(/\.biprivatekey$/i, "");

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
      <DialogContent className="max-h-[calc(100vh-3rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${mod?.name}` : "Add a mod"}</DialogTitle>
          <DialogDescription>
            Point at the mod's unpacked folder. The prefix and PBOs are worked out from it, and you can override them.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="sourcePath">Source folder</FieldLabel>
            <PathInput
              id="sourcePath"
              value={draft.sourcePath}
              onChange={changeSource}
              placeholder="P:\Mods\Unpacked\MyMod"
              dialogTitle="Choose the mod's source folder"
              invalid={inspection ? !inspection.sourceExists : false}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input
                id="name"
                value={draft.name}
                onChange={(e) => {
                  setNameTouched(true);
                  update({ name: e.target.value });
                }}
                placeholder={fileName(draft.sourcePath) || "My mod"}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="prefix">Prefix</FieldLabel>
              <Input
                id="prefix"
                value={draft.prefix ?? ""}
                onChange={(e) => update({ prefix: e.target.value })}
                placeholder={inspection?.detectedPrefix || "Detected from the folder"}
                spellCheck={false}
                className="font-mono md:text-xs"
              />
              <FieldDescription>
                {inspection && !draft.prefix ? (
                  <>
                    Detected {prefixSourceLabel(inspection.detectedFrom)}
                    {inspection.detectedFrom === "configPaths" && inspection.evidence && (
                      <>
                        {" "}
                        (<span className="font-mono">{inspection.evidence}</span>)
                      </>
                    )}
                    . Leave blank to use it.
                  </>
                ) : (
                  "Leave blank to detect it."
                )}
              </FieldDescription>
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="outputPath">Output folder</FieldLabel>
            <PathInput
              id="outputPath"
              value={draft.outputPath}
              onChange={(outputPath) => {
                setOutputTouched(true);
                update({ outputPath });
              }}
              placeholder="P:\Mods\Packed\@MyMod"
              dialogTitle="Choose the @mod output folder"
            />
            <FieldDescription>The @mod folder. PBOs go into its addons folder and the key into keys.</FieldDescription>
          </Field>

          {inspection?.sourceExists && <ModPlan inspection={inspection} />}

          {/* Also while a name is set, so one left over from when the mod made one PBO can be cleared. */}
          {(singlePbo || draft.pboName) && (
            <Field>
              <FieldLabel htmlFor="pboName">PBO name</FieldLabel>
              <Input
                id="pboName"
                value={draft.pboName ?? ""}
                onChange={(e) => update({ pboName: e.target.value })}
                placeholder={singlePbo ? inspection?.pbos[0]?.name : undefined}
                spellCheck={false}
              />
              <FieldDescription>
                {singlePbo
                  ? "Optional. Renames the PBO without changing its prefix."
                  : "Only used when the mod makes one PBO. Clear it if you don't need it."}
              </FieldDescription>
            </Field>
          )}

          <FieldSeparator />

          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Binarise</FieldTitle>
              <FieldDescription>Turns config.cpp into config.bin. Turn off to ship configs as text.</FieldDescription>
            </FieldContent>
            <Switch checked={draft.binarise} onCheckedChange={(binarise) => update({ binarise })} />
          </Field>

          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Convert PNGs</FieldTitle>
              <FieldDescription>
                Converts PNGs to PAA. Turn off if the mod uses PNGs as they are, which is common in GUIs.
              </FieldDescription>
            </FieldContent>
            <Switch checked={draft.convertPng} onCheckedChange={(convertPng) => update({ convertPng })} />
          </Field>

          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Sign</FieldTitle>
              <FieldDescription>
                {keyName
                  ? `Signs each PBO with ${keyName} and copies ${keyName}.bikey into keys.`
                  : "Choose a private key below or in Settings."}
              </FieldDescription>
            </FieldContent>
            <Switch checked={draft.sign} onCheckedChange={(sign) => update({ sign })} />
          </Field>

          {draft.sign && (
            <Field>
              <FieldLabel htmlFor="privateKeyPath">Private key</FieldLabel>
              <PathInput
                id="privateKeyPath"
                value={draft.privateKeyPath ?? ""}
                onChange={(privateKeyPath) => update({ privateKeyPath })}
                placeholder={settings.defaultPrivateKeyPath || "Choose a .biprivatekey"}
                filters={[{ name: "Private key", extensions: ["biprivatekey"] }]}
                dialogTitle="Choose a private key"
              />
              <FieldDescription>Leave blank to use the default key from Settings.</FieldDescription>
            </Field>
          )}

          {inspection?.hasModCpp && (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>Copy mod.cpp</FieldTitle>
                <FieldDescription>Copies the mod's mod.cpp into the @mod folder.</FieldDescription>
              </FieldContent>
              <Switch checked={draft.copyModCpp} onCheckedChange={(copyModCpp) => update({ copyModCpp })} />
            </Field>
          )}
        </FieldGroup>

        <DialogFooter className="sm:justify-between">
          <div>
            {onRemove && (
              <AlertDialog>
                <AlertDialogTrigger render={<Button variant="destructive" />}>Remove mod</AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Remove {mod?.name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This only removes it from the list. Its source and packed files stay where they are.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep it</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={onRemove}>
                      Remove
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={requestClose}>
              Cancel
            </Button>
            <DisabledHint
              reason={
                saving
                  ? null
                  : !draft.sourcePath.trim()
                    ? "Choose the mod's source folder."
                    : !draft.outputPath.trim()
                      ? "Choose an output folder."
                      : null
              }
            >
              <Button onClick={save} disabled={saving || !draft.sourcePath.trim() || !draft.outputPath.trim()}>
                {editing ? "Save changes" : "Add mod"}
              </Button>
            </DisabledHint>
          </div>
        </DialogFooter>

        <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{editing ? `Discard your changes to ${mod?.name}?` : "Discard this mod?"}</AlertDialogTitle>
              <AlertDialogDescription>
                {editing
                  ? "They haven't been saved, so closing throws them away."
                  : "It hasn't been added yet, so closing throws it away."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  setConfirmDiscard(false);
                  onOpenChange(false);
                }}
              >
                Discard
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
