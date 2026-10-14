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
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Install version {version}?</AlertDialogTitle>
          <AlertDialogDescription>
            Flare Tools will close, install the update in the background and open again in a few seconds. A build or
            upload that's still running will be stopped.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Not now</AlertDialogCancel>
          <AlertDialogAction
            // A failed install shows on the update icon.
            onClick={() => void api.installUpdate().catch(() => {})}
          >
            Install and restart
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
