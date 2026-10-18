import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpenIcon } from "lucide-react";

import { Button } from "@flare/ui/ui/button";
import { Input } from "@flare/ui/ui/input";

interface PathInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Picks a folder by default; pass filters to pick a file instead. */
  filters?: { name: string; extensions: string[] }[];
  invalid?: boolean;
  dialogTitle: string;
}

export function PathInput({ id, value, onChange, placeholder, filters, invalid, dialogTitle }: PathInputProps) {
  async function browse() {
    const picked = await open({
      title: dialogTitle,
      directory: !filters,
      multiple: false,
      filters,
      defaultPath: value || undefined,
    });
    if (typeof picked === "string") onChange(picked);
  }

  return (
    <div className="flex gap-2">
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        spellCheck={false}
        className="font-mono md:text-xs"
      />
      <Button type="button" variant="outline" onClick={browse}>
        <FolderOpenIcon data-icon="inline-start" />
        Browse
      </Button>
    </div>
  );
}
