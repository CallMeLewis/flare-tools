# How it works

What the Build and Workshop tools do behind the scenes, and why.

## What a build does

1. Works out the prefix and the PBOs the mod will produce.
2. Runs pboProject, with binarising and PNG conversion turned on or off per mod, and streams its log into the app.
3. Renames the PBO if you've given it a different name, then moves everything else in the `addons` folder to the
   Recycle Bin, such as old PBOs, their signatures and stray files, so nothing stale is uploaded. Folders in it are
   left alone, and the Workshop upload warns about them. Because of this, the output folder can't be a whole drive, a
   DayZ or DayZ server install, or the mod's source folder. Mods can share an output folder, such as a mod's client
   and server halves added as two mods: the PBOs and signatures of the others built into it are kept, as are the
   mod's own unticked PBOs (see [PBOs](#pbos)).
4. Signs each PBO with DSSignFile and copies the matching `.bikey` into the mod's `keys` folder, if signing is on.
5. Puts a `mod.cpp` in the `@mod` folder, if that option is on: the mod's own, with its `version` set to the one in
   the mod's `CfgMods` class so the two always agree, or one written from that class if the mod hasn't got one. In
   an output folder shared with a mod that has a `mod.cpp` of its own, a mod without one leaves that mod's in place.
   The mod's source folder is never changed.

Output follows the usual layout: `@Mod\addons\*.pbo`, `*.bisign` next to each PBO, and `@Mod\keys\*.bikey`.

## Prefixes

pboProject ignores `prefix=` in `$PBOPREFIX$` and works the prefix out from where the source sits on the P: drive. A
mod in `P:\Mods\Unpacked\MyMod` would get the prefix `Mods\Unpacked\MyMod`, which is almost never what you want.

So the app picks the prefix first and then makes sure pboProject sees the source at `P:\<prefix>`:

- **Detected prefix**, in order of preference:
  1. a `$PBOPREFIX$` file in the mod folder
  2. the trailing part of the folder path that the mod's `config.cpp` files refer to (e.g.
     `files[] = {"MyMod/Scripts/4_World"}` gives `MyMod`)
  3. the folder name
- **Override**: you can type your own prefix for any mod.
- **Building from outside `P:\<prefix>`**: the app creates a temporary junction at `P:\<prefix>` that points to the
  source, and removes it after the build. If `P:\<prefix>` already exists and is a different folder, the build is
  blocked rather than packing the wrong files.

## PBOs

Like pboProject, the app treats each folder with a `config.cpp` (and no `config.cpp` above it) as a PBO. A mod with
`config.cpp` in its root becomes one PBO. A mod made of several addon folders becomes one PBO per folder, each with a
prefix such as `MyMod\gear\medical`.

A mod of several PBOs has a tick box beside each under Packing. Unticking one leaves it out of the mod's builds: its
last build and signatures stay in `addons`, and pboProject packs each ticked folder on its own rather than the whole
mod. The choice is saved with the mod, and a PBO added to the mod later starts ticked.

## Things pboProject still controls

The app passes `+Restore`, so pboProject's own GUI settings are never changed by a build. Settings the app doesn't
set, such as files to exclude from PBOs and compression, still come from pboProject's Setup screen.

## Workshop

The Workshop tool does what DayZ Publisher does. It talks to the running Steam client through the Steamworks API,
signed in as DayZ (app 221100), which is what lets it publish to DayZ's Workshop. That means:

- Steam has to be running, signed in to an account that owns DayZ.
- While it's connected, Steam shows you as playing DayZ. The app connects only when it needs to and disconnects after
  90 seconds without a request.
- New items start out private. Steam hides items until you've accepted the
  [Workshop legal agreement](https://steamcommunity.com/sharedfiles/workshoplegalagreement); the app tells you if
  that's needed.
- Saving the page and uploading a new version are separate. "Upload new version" sends the files and a change note;
  Steam only uploads what changed, so re-uploading costs little.
- Each upload first writes a `meta.cpp` into the folder with the item's ID and title, as DayZ Publisher does. Servers
  report a mod's Workshop ID from it, so without one launchers see the mod as ID 0 and can't download it.

The app remembers which folder you last uploaded for each item, in `%APPDATA%\com.darkzone.flaretools\data.json`.
