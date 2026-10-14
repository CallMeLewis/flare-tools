import { SparklesIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** Release notes as a bulleted list. Always plain text: the notes in the update feed are not signed. */
export function ReleaseNotesList({ items, className }: { items: string[]; className?: string }) {
  return (
    <ul className={cn("list-disc space-y-1 pl-4", className)}>
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

/**
 * A small "What's new" link that opens a version's release notes. As a link it sits inside a sentence; as a chip it
 * stands on its own beside a label.
 */
export function ReleaseNotesLink({
  version,
  items,
  description,
  label = "What's new",
  appearance = "link",
}: {
  version: string;
  items: string[];
  description?: string;
  label?: string;
  appearance?: "link" | "chip";
}) {
  const trigger =
    appearance === "chip" ? (
      <Button variant="secondary" size="xs" className="font-normal" />
    ) : (
      <Button variant="link" className="h-auto p-0 text-xs font-normal" />
    );
  return (
    <Dialog>
      <DialogTrigger render={trigger}>
        {appearance === "chip" && <SparklesIcon data-icon="inline-start" />}
        {label}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>What's new in version {version}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          <ReleaseNotesList items={items} className="space-y-2 text-sm leading-relaxed" />
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="secondary" />}>Close</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
