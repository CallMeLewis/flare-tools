import { cn } from "@/lib/utils";
import { textBytes } from "@/lib/workshop";

/** How much of one of Steam's limits a value uses. */
export function Counter({ value, max }: { value: string; max: number }) {
  const used = textBytes(value);
  return (
    <span
      className={cn("text-xs tabular-nums", used > max ? "text-destructive" : "text-muted-foreground")}
      title={used !== value.length ? "Steam counts bytes, and some characters take two or more." : undefined}
    >
      {used.toLocaleString("en-GB")} / {max.toLocaleString("en-GB")}
    </span>
  );
}
