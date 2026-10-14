import { cn } from "@/lib/utils";

/** Characters used against one of Steam's limits. */
export function Counter({ value, max }: { value: string; max: number }) {
  const over = value.length > max;
  return (
    <span className={cn("text-xs tabular-nums", over ? "text-destructive" : "text-muted-foreground")}>
      {value.length.toLocaleString("en-GB")} / {max.toLocaleString("en-GB")}
    </span>
  );
}
