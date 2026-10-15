import { toast } from "sonner";

import { api, errorMessage } from "@/lib/api";

/** Opens a web or steam:// link in the app Windows uses for it, saying so if that didn't work. */
export function openLink(url: string) {
  api.openUrl(url).catch((error) => toast.error("Couldn't open the link", { description: errorMessage(error) }));
}

/** Opens a folder in Explorer, or the folder it would go in if it doesn't exist yet, saying so if neither does. */
export function openFolder(path: string) {
  api.openFolder(path).catch((error) => toast.error("Couldn't open the folder", { description: errorMessage(error) }));
}
