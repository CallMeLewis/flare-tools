import { useEffect, useState } from "react";
import { UnplugIcon, UserRoundIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@flare/ui/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage, OPEN_STEAM_URL, type SteamPresence } from "@/lib/api";

// Steam can take a while to start. After this long the button can be pressed again, in case it didn't.
const STARTING_MS = 30_000;

/** Starts Steam, or brings it to the front. */
export function openSteam() {
  api.openUrl(OPEN_STEAM_URL).catch((error) => toast.error("Couldn't start Steam", { description: errorMessage(error) }));
}

/** Shown in place of the app until Steam is running and signed in. It moves on by itself once it is. */
export function SteamGate({ presence }: { presence: SteamPresence | null }) {
  const [starting, setStarting] = useState(false);

  // A change means Steam is getting somewhere, so the button is worth showing again.
  useEffect(() => setStarting(false), [presence]);
  useEffect(() => {
    if (!starting) return;
    const timer = window.setTimeout(() => setStarting(false), STARTING_MS);
    return () => window.clearTimeout(timer);
  }, [starting]);

  // The first check is near instant, so show nothing rather than flash a spinner.
  if (!presence || presence === "signedIn") return <div className="flex-1" />;

  const signedOut = presence === "signedOut";
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">{signedOut ? <UserRoundIcon /> : <UnplugIcon />}</EmptyMedia>
        <div aria-live="polite" className="contents">
          <EmptyTitle>{signedOut ? "Sign in to Steam" : "Steam isn't running"}</EmptyTitle>
          <EmptyDescription>
            {signedOut
              ? "Steam is open, but no one is signed in. Flare Tools publishes to the Workshop as whoever is."
              : "Flare Tools publishes to the Workshop through Steam. Start Steam and sign in, and the app opens by itself."}
          </EmptyDescription>
        </div>
      </EmptyHeader>
      <EmptyContent className="gap-4">
        <Button
          onClick={() => {
            setStarting(true);
            openSteam();
          }}
          disabled={starting}
        >
          {starting && <Spinner data-icon="inline-start" />}
          {starting ? "Starting Steam…" : signedOut ? "Open Steam" : "Start Steam"}
        </Button>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          Waiting for Steam…
        </p>
      </EmptyContent>
    </Empty>
  );
}
