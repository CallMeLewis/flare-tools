import { useState } from "react";

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
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

/** Confirmation before a downloaded update installs. The installer runs silently, so this is the only prompt. */
export function InstallUpdateDialog({
  version,
  open,
  onOpenChange,
}: {
  version: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // The app closes once the installer starts, so this only ends if starting it fails.
  const [installing, setInstalling] = useState(false);

  function install() {
    setInstalling(true);
    // A failed install shows on the update icon.
    void api.installUpdate().catch(() => {
      setInstalling(false);
      onOpenChange(false);
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !installing && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Install version {version}?</AlertDialogTitle>
          <AlertDialogDescription>
            Flare Tools will close, install the update in the background and open again in a few seconds. A build or
            upload that's still running will be stopped.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={installing}>Not now</AlertDialogCancel>
          <AlertDialogAction onClick={install} disabled={installing}>
            {installing && <Spinner data-icon="inline-start" />}
            {installing ? "Installing…" : "Install and restart"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
