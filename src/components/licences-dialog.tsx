import { useState } from "react";
import { ExternalLinkIcon, ScaleIcon } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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
import { api, errorMessage } from "@/lib/api";
// Built into the app, since the font's licence has to travel with it.
import geistLicence from "../../licenses/OFL-geist.txt?raw";

const STEAMWORKS_TERMS_URL = "https://partner.steamgames.com/documentation/sdk_access_agreement";

interface Component {
  name: string;
  licence: string;
  detail: string;
  link?: { label: string; url: string };
  /** The licence's full text, shown in place. */
  text?: string;
}

function openLink(url: string) {
  api.openUrl(url).catch((error) => toast.error("Couldn't open the link", { description: errorMessage(error) }));
}

/** The app's own licence and what it ships with, behind a "View licences" button. */
export function LicencesDialog({ author, repoUrl }: { author: string; repoUrl: string }) {
  const components: Component[] = [
    {
      name: "Flare Tools",
      licence: "GPL v3",
      detail: `Copyright © 2026 ${author}. Free software: you can share and change it under the GNU General Public License v3. It comes with no warranty, as far as the law allows.`,
      link: { label: "Read the licence", url: `${repoUrl}/blob/main/LICENSE` },
    },
    {
      name: "Steamworks API",
      licence: "Steamworks SDK",
      detail:
        "steam_api64.dll from Valve, used to publish to the Workshop through Steam. It isn't covered by the GPL. Steam and Steamworks are trademarks of Valve Corporation.",
      link: { label: "Valve's terms", url: STEAMWORKS_TERMS_URL },
    },
    {
      name: "Geist",
      licence: "OFL 1.1",
      detail: "The app's typeface. Copyright 2024 The Geist Project Authors.",
      text: geistLicence,
    },
    {
      name: "Libraries",
      licence: "MIT, Apache 2.0 and others",
      detail:
        "Tauri, React, Base UI and the rest of what the app is built with. They keep their own licences, all compatible with the GPL v3.",
      link: { label: "See the full list", url: `${repoUrl}/blob/main/NOTICE.md` },
    },
    {
      name: "pboProject and DayZ Tools",
      licence: "Not included",
      detail:
        "Made by Mikero and Bohemia Interactive. Flare Tools runs the copies you have installed, which keep their own licences. It isn't made, endorsed or supported by either. DayZ is a trademark of Bohemia Interactive a.s.",
    },
  ];

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" className="shrink-0" />}>
        <ScaleIcon data-icon="inline-start" />
        View licences
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Licences</DialogTitle>
          <DialogDescription>Flare Tools, the parts it ships with and the tools it runs.</DialogDescription>
        </DialogHeader>
        <ul className="-mx-1 max-h-[60vh] divide-y overflow-y-auto rounded-lg border">
          {components.map((component) => (
            <LicenceEntry key={component.name} {...component} />
          ))}
        </ul>
        <DialogFooter>
          <DialogClose render={<Button variant="secondary" />}>Close</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LicenceEntry({ name, licence, detail, link, text }: Component) {
  const [showText, setShowText] = useState(false);
  return (
    <li className="flex flex-col gap-1.5 p-3">
      <p className="flex items-center gap-2 text-sm font-medium">
        {name}
        <Badge variant="outline" className="font-normal text-muted-foreground">
          {licence}
        </Badge>
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">{detail}</p>
      {link && (
        <Button variant="link" className="h-auto self-start p-0 text-xs font-normal" onClick={() => openLink(link.url)}>
          {link.label}
          <ExternalLinkIcon data-icon="inline-end" />
        </Button>
      )}
      {text && (
        <>
          <Button
            variant="link"
            className="h-auto self-start p-0 text-xs font-normal"
            aria-expanded={showText}
            onClick={() => setShowText((shown) => !shown)}
          >
            {showText ? "Hide licence text" : "Show licence text"}
          </Button>
          {showText && (
            <pre className="max-h-48 overflow-auto rounded-md bg-muted/60 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground select-text dark:bg-background">
              {text}
            </pre>
          )}
        </>
      )}
    </li>
  );
}
