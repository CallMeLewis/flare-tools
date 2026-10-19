import { useId } from "react";
import { CircleAlertIcon, Link2Icon, PackageIcon } from "lucide-react";

import { Checkbox } from "@flare/ui/ui/checkbox";
import type { Inspection, PboPlan, PrefixSource } from "@/lib/api";
import { cn } from "@/lib/utils";

const SOURCE_LABELS: Record<PrefixSource, string> = {
  override: "set manually",
  prefixFile: "from $PBOPREFIX$",
  configPaths: "from config.cpp paths",
  folderName: "from the folder name",
};

export function prefixSourceLabel(source: PrefixSource): string {
  return SOURCE_LABELS[source];
}

/** Whether a PBO is unticked, leaving it out of builds. A mod of one PBO always builds it, as the build does. */
export function isSkipped(inspection: Inspection, skipped: string[], pbo: PboPlan): boolean {
  return inspection.pbos.length > 1 && skipped.some((dir) => dir.toLowerCase() === pbo.relDir.toLowerCase());
}

interface ModPlanProps {
  inspection: Inspection;
  /** The relDir of each unticked PBO. Leave out, with onSkippedChange, to list the PBOs without tick boxes. */
  skipped?: string[];
  onSkippedChange?: (skipped: string[]) => void;
  disabled?: boolean;
}

/** The PBOs a build will produce, plus anything that would stop it. A mod of several PBOs can untick some to leave
 * them out of its builds. */
export function ModPlan({ inspection, skipped, onSkippedChange, disabled }: ModPlanProps) {
  const id = useId();
  const pbos = inspection.pbos;
  const choosing = Boolean(skipped && onSkippedChange) && pbos.length > 1;
  const ticked = choosing ? pbos.filter((pbo) => !isSkipped(inspection, skipped ?? [], pbo)) : pbos;
  const all = ticked.length === pbos.length;
  // Saves only the PBOs the mod has now, so ones since removed from it don't linger.
  const untick = (unticked: (pbo: PboPlan) => boolean) =>
    onSkippedChange?.(pbos.filter(unticked).map((pbo) => pbo.relDir));

  return (
    <div className="flex flex-col gap-3">
      {pbos.length > 0 && (
        <div className="flex flex-col rounded-lg border">
          {choosing && (
            <div className="flex items-center gap-2.5 border-b px-3 py-2 text-xs text-muted-foreground">
              <Checkbox
                id={`${id}-all`}
                checked={all ? true : ticked.length === 0 ? false : "indeterminate"}
                disabled={disabled}
                onCheckedChange={() => untick(() => all)}
              />
              <label htmlFor={`${id}-all`} className={cn("font-medium", !disabled && "cursor-pointer")}>
                Build every PBO
              </label>
              <span className="ml-auto tabular-nums">{all ? `All ${pbos.length}` : `${ticked.length} of ${pbos.length}`}</span>
            </div>
          )}
          <ul className="flex flex-col divide-y divide-border">
            {pbos.map((pbo, index) => {
              const key = pbo.relDir || pbo.name;
              const off = choosing && !ticked.includes(pbo);
              const details = (
                <>
                  {/* The name is what tells the PBOs apart, so the prefix gives way to it. */}
                  <span className="flex max-w-[65%] min-w-0 shrink-0 flex-col">
                    <span
                      className={cn("truncate font-medium select-text transition-colors", off && "text-muted-foreground")}
                      title={`${pbo.name}.pbo`}
                    >
                      {pbo.name}.pbo
                    </span>
                    {pbo.packedName !== pbo.name && (
                      <span className="text-xs text-muted-foreground">Renamed from {pbo.packedName}.pbo</span>
                    )}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-right font-mono text-xs text-muted-foreground select-text"
                    title={pbo.prefix}
                  >
                    {pbo.prefix}
                  </span>
                </>
              );
              if (!choosing) {
                return (
                  <li key={key} className="flex items-center gap-2.5 px-3 py-2">
                    <PackageIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    {details}
                  </li>
                );
              }
              // The whole row is the tick box's label, so it can be clicked anywhere.
              return (
                <li key={key}>
                  <label
                    htmlFor={`${id}-${index}`}
                    className={cn(
                      "flex items-center gap-2.5 px-3 py-2 transition-colors",
                      !disabled && "cursor-pointer hover:bg-muted/50",
                    )}
                  >
                    <Checkbox
                      id={`${id}-${index}`}
                      checked={!off}
                      disabled={disabled}
                      onCheckedChange={(checked) =>
                        untick((other) => (other === pbo ? checked !== true : !ticked.includes(other)))
                      }
                    />
                    {details}
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {inspection.link === "junction" && (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Link2Icon className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            pboProject works the prefix out from the folder's place on the P: drive, so builds go through a temporary
            link at <span className="font-mono">{inspection.buildPath}</span> that's removed afterwards.
          </span>
        </p>
      )}
      {/* Red for what stops the build, amber for what only needs a look. */}
      {inspection.warnings.map((warning) => (
        <p
          key={warning}
          className={cn(
            "flex items-start gap-2 text-xs",
            warning === inspection.problem ? "text-destructive" : "text-warning",
          )}
        >
          <CircleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{warning}</span>
        </p>
      ))}
    </div>
  );
}
