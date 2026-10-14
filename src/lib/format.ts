const relative = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });
const absolute = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

export function timeAgo(ms: number, now = Date.now()): string {
  const seconds = Math.round((ms - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), "hour");
  if (abs < 86400 * 30) return relative.format(Math.round(seconds / 86400), "day");
  return absolute.format(ms);
}

const short = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

/** 14 Oct */
export function shortDate(ms: number): string {
  return short.format(ms);
}

export function dateTime(ms: number): string {
  return absolute.format(ms);
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const compact = new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 });

/** 1,284 stays as is; bigger counts shorten to 12.9K, 4.2M. */
export function compactNumber(n: number): string {
  return n < 10_000 ? n.toLocaleString("en-GB") : compact.format(n);
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function joinPath(dir: string, name: string): string {
  if (!dir) return "";
  return `${dir.replace(/[\\/]+$/, "")}\\${name}`;
}
