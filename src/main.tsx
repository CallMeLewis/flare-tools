import React from "react";
import ReactDOM from "react-dom/client";
import { blockWebviewMenu, FlareProvider, type InstallNotice } from "@flare/ui";
import App from "./App";
import "./index.css";

// The web view's own menu (Back, Reload, Inspect) has no place in a desktop app. Text fields keep theirs, for pasting
// a path.
blockWebviewMenu();

/** What the update's install prompt adds: installing closes the app, which stops a build or upload. */
function useInstallNotice(): InstallNotice {
  return { note: "A build or upload that's still running will be stopped." };
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <FlareProvider
      app={{ name: "Flare Tools", version: __APP_VERSION__, releaseNotes: __APP_RELEASE_NOTES__ }}
      useInstallNotice={useInstallNotice}
    >
      <App />
    </FlareProvider>
  </React.StrictMode>,
);
