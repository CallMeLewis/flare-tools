import { CircleAlertIcon, Link2Icon, PackageIcon } from "lucide-react";

import type { Inspection, PrefixSource } from "@/lib/api";
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

/** The PBOs a build will produce, plus anything that would stop it. */
export function ModPlan({ inspection }: { inspection: Inspection }) {
  return (
    <div className="flex flex-col gap-3">
      {inspection.pbos.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-lg border">
          {inspection.pbos.map((pbo) => (
            <li key={pbo.relDir || pbo.name} className="flex items-center gap-2.5 px-3 py-2">
              <PackageIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="flex min-w-0 flex-col">
                <span className="font-medium select-text">{pbo.name}.pbo</span>
                {pbo.packedName !== pbo.name && (
                  <span className="text-xs text-muted-foreground">Renamed from {pbo.packedName}.pbo</span>
                )}
              </span>
              <span className="ml-auto truncate font-mono text-xs text-muted-foreground select-text" title={pbo.prefix}>
                {pbo.prefix}
              </span>
            </li>
          ))}
        </ul>
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
