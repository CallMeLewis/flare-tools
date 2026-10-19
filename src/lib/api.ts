import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface Settings {
  pDrive: string;
  pboProjectPath: string;
  dsSignFilePath: string;
  defaultPrivateKeyPath: string;
  defaultOutputRoot: string;
}

export interface LastBuild {
  finishedAt: number;
  ok: boolean;
  durationMs: number;
  pbos: string[];
  signed: boolean;
}

export interface ModConfig {
  id: string;
  name: string;
  sourcePath: string;
  prefix: string | null;
  outputPath: string;
  pboName: string | null;
  binarise: boolean;
  sign: boolean;
  privateKeyPath: string | null;
  copyModCpp: boolean;
  convertPng: boolean;
  /** The folders of the PBOs left out of builds, as each PBO's relDir. */
  skippedPbos: string[];
  lastBuild: LastBuild | null;
}

export interface AppData {
  settings: Settings;
  mods: ModConfig[];
}

export type PrefixSource = "override" | "prefixFile" | "configPaths" | "folderName";
export type LinkStatus = "direct" | "junction" | "conflict" | "noPDrive" | "badPrefix";

export interface PboPlan {
  name: string;
  packedName: string;
  relDir: string;
  prefix: string;
}

/** What a mod says about itself, in mod.cpp or its CfgMods class. */
export interface ModMeta {
  name: string | null;
  author: string | null;
  version: string | null;
}

export interface Inspection {
  sourceExists: boolean;
  /** From mod.cpp in the mod folder, when there is one. */
  modCpp: ModMeta | null;
  /** From the mod's class under CfgMods, in whichever config.cpp declares it. */
  cfgMods: ModMeta | null;
  folderName: string;
  detectedPrefix: string;
  detectedFrom: PrefixSource;
  evidence: string | null;
  prefix: string;
  prefixSource: PrefixSource;
  pbos: PboPlan[];
  hasModCpp: boolean;
  buildPath: string;
  link: LinkStatus;
  /** Why the mod can't be built, if it can't. It's one of the warnings too. */
  problem: string | null;
  warnings: string[];
}

export interface ModStatus {
  id: string;
  sourceExists: boolean;
  lastModified: number | null;
  problem: string | null;
  /** The version the mod declares, from its CfgMods class or failing that mod.cpp. */
  version: string | null;
}

export type Step = "prepare" | "pack" | "sign" | "finish";
export type StepStatus = "running" | "done" | "failed" | "skipped";
export type LogLevel = "info" | "command" | "output" | "warning" | "error" | "success";

export type BuildEvent =
  | { type: "step"; modId: string; step: Step; status: StepStatus }
  | { type: "log"; modId: string; level: LogLevel; text: string };

export interface BuiltPbo {
  name: string;
  prefix: string | null;
  path: string;
  size: number;
  signed: boolean;
}

export interface BuildOutcome {
  ok: boolean;
  cancelled: boolean;
  durationMs: number;
  finishedAt: number;
  pbos: BuiltPbo[];
  signed: boolean;
  warnings: string[];
  error: string | null;
}

export interface StepRecord {
  step: Step;
  status: StepStatus;
}

export interface SavedLogLine {
  level: LogLevel;
  text: string;
}

/** A build kept on disk, newest first when listed. Its log is fetched separately. */
export interface BuildRecord {
  id: string;
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  cancelled: boolean;
  durationMs: number;
  signed: boolean;
  pbos: BuiltPbo[];
  warnings: string[];
  error: string | null;
  steps: StepRecord[];
  logLines: number;
}

export type SteamStatus =
  | { state: "ready"; userName: string; steamId: string }
  | { state: "unavailable"; message: string };

/** Whether the Steam client is up, read without connecting to it. */
export type SteamPresence = "notRunning" | "signedOut" | "signedIn";

export type Visibility = "public" | "friendsOnly" | "unlisted" | "private";

export interface WorkshopItem {
  /** A 64-bit id, kept as a string because it doesn't fit in a JS number. */
  id: string;
  title: string;
  description: string;
  tags: string[];
  visibility: Visibility;
  previewUrl: string | null;
  /** Milliseconds since the Unix epoch. */
  timeCreated: number;
  timeUpdated: number;
  fileSize: number;
  stats: ItemStats;
  /** The folder last uploaded from this app, remembered locally. */
  contentPath: string | null;
  /** Daily snapshots of the stats recorded by this app, oldest first. Today's is always last. */
  history: StatSnapshot[];
}

export interface ContentSummary {
  exists: boolean;
  pbos: string[];
  keys: string[];
  hasModCpp: boolean;
  fileCount: number;
  totalSize: number;
  warnings: string[];
}

/** Steam's running totals for an item. Lifetime figures, refreshed by Steam every few hours. */
export interface ItemStats {
  subscriptions: number;
  uniqueSubscriptions: number;
  favorites: number;
  followers: number;
  uniqueWebsiteViews: number;
  comments: number;
  upvotes: number;
  downvotes: number;
  secondsPlayed: number;
  playtimeSessions: number;
}

export interface StatSnapshot {
  /** Milliseconds since the Unix epoch. */
  at: number;
  stats: ItemStats;
}

export interface PublishRequest {
  /** Null creates a new item. */
  itemId: string | null;
  title: string;
  description: string;
  tags: string[];
  visibility: Visibility;
  /** Leave null to keep the current preview image. */
  previewPath: string | null;
  /** Leave null to keep the current files. */
  contentPath: string | null;
  changeNote: string;
  /** False sends only the files and change note, leaving the page as it is on Steam. A new item always sends it. */
  sendPage: boolean;
}

export type PublishStage = "creating" | "preparing" | "uploadingContent" | "uploadingPreview" | "committing";

export interface PublishProgress {
  itemId: string | null;
  stage: PublishStage;
  processed: number;
  total: number;
}

export interface PublishOutcome {
  itemId: string;
  /** Steam won't show the item until the Workshop legal agreement has been accepted. */
  needsAgreement: boolean;
}

export const api = {
  getData: () => invoke<AppData>("get_data"),
  /** What went wrong reading the saved mods and settings at startup. Only returned once. */
  takeDataNotice: () => invoke<string | null>("take_data_notice"),
  /** Lets the smoke test know the interface has drawn. Does nothing outside it. */
  interfaceReady: () => invoke<void>("interface_ready"),
  detectTools: () => invoke<Settings>("detect_tools"),
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
  inspectMod: (sourcePath: string, prefix: string | null, pboName: string | null) =>
    invoke<Inspection>("inspect_mod", { sourcePath, prefix, pboName }),
  saveMod: (config: ModConfig) => invoke<ModConfig>("save_mod", { config }),
  removeMod: (id: string) => invoke<void>("remove_mod", { id }),
  modStatuses: () => invoke<ModStatus[]>("mod_statuses"),
  buildMod: (id: string) => invoke<BuildOutcome>("build_mod", { id }),
  cancelBuild: () => invoke<void>("cancel_build"),
  buildHistory: (modId: string) => invoke<BuildRecord[]>("build_history", { modId }),
  buildLog: (modId: string, buildId: string) => invoke<SavedLogLine[]>("build_log", { modId, buildId }),
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),
  openFolder: (path: string) => invoke<void>("open_folder", { path }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  steamStatus: () => invoke<SteamStatus>("steam_status"),
  steamPresence: () => invoke<SteamPresence>("steam_presence"),
  workshopItems: () => invoke<WorkshopItem[]>("workshop_items"),
  readFile: (path: string) => invoke<ArrayBuffer>("read_file", { path }),
  inspectContent: (path: string) => invoke<ContentSummary>("inspect_content", { path }),
  publishItem: (request: PublishRequest) => invoke<PublishOutcome>("publish_item", { request }),
};

export function onPublishProgress(handler: (progress: PublishProgress) => void): Promise<UnlistenFn> {
  return listen<PublishProgress>("publish-progress", (e) => handler(e.payload));
}

/** The item's Workshop page, opened in the Steam client rather than the browser. */
export function workshopUrl(id: string): string {
  return `steam://url/CommunityFilePage/${id}`;
}

/** Starts the Steam client, or brings it to the front if it's already running. */
export const OPEN_STEAM_URL = "steam://open/main";

/** Opens a web page inside the Steam client, where the user is already signed in. */
export function steamUrl(url: string): string {
  return `steam://openurl/${url}`;
}

export function onBuildEvent(handler: (event: BuildEvent) => void): Promise<UnlistenFn> {
  return listen<BuildEvent>("build-event", (e) => handler(e.payload));
}

/** Tauri rejects commands with the error string returned from Rust. */
export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "Something went wrong.";
}

/** The item a failed publish created before it failed, which trying again should finish. */
export function createdItemId(error: unknown): string | null {
  if (error && typeof error === "object" && "itemId" in error && typeof error.itemId === "string") {
    return error.itemId;
  }
  return null;
}
