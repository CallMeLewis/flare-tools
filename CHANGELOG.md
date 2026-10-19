# Changelog

What changed in each version of Flare Tools, newest first.

## 0.5.0 - 2026-10-19

- New tick boxes beside each PBO under Packing let you choose which of a mod's PBOs to build, for a mod of several. An unticked PBO keeps its last build and signatures in the addons folder, and the choice is saved with the mod.

## 0.4.0 - 2026-10-18

- Build and Workshop are now in a sidebar on the left instead of the title bar, with Settings and the update button at its foot; it shrinks to icons when the window is narrow.
- The Mods and Workshop items lists now sit below the page's title and buttons, alongside the rest of the page.
- New font and colours throughout Flare Tools, with its orange kept for the app's mark.
- Right-clicking no longer opens a browser menu with Back, Reload and Inspect; text fields still have Cut, Copy and Paste.

## 0.3.2 - 2026-10-17

- Fixed building a mod removing the PBOs of other mods built into the same output folder, such as a mod's client and server halves added as two mods.

## 0.3.1 - 2026-10-17

- Action needed: uploading a new version left out the meta.cpp that tells servers the mod's Workshop ID, so servers running it showed the mod with an ID of 0 and launchers couldn't download it; upload a new version of any item you've updated with Flare Tools to put it back.
- Uploading a new version now warns about anything in the addons folder that DayZ won't load, such as a stray mod.cpp.
- Building a mod now removes files from its addons folder that the build didn't produce, such as old PBOs and their signatures, so they aren't uploaded with the mod; each one is listed in the build log.

## 0.3.0 - 2026-10-15

- New: building a mod that hasn't got a mod.cpp now writes one into the @mod folder from config.cpp, so the DayZ launcher shows its name and version; turn off Add mod.cpp on the mod to skip it.
- When pboProject stops because it can't find files the mod refers to, such as models from a map the mod builds on, the build now names the files and the P: drive folders they belong in, instead of only pointing at the log.
- After you upload a new version of a Workshop item, the upload window now says it's done and offers View on Steam.
- Each build option on a mod's page now has an info icon that explains what it does.
- Copy mod.cpp is now called Add mod.cpp and sets the version in the copied mod.cpp to the one in config.cpp, which is also the version the mod's page now shows.

## 0.2.0 - 2026-10-15

- Closing Flare Tools or installing an update during a build now stops the build cleanly, and if Flare Tools ever closes unexpectedly, the temporary link it made on the P: drive is removed the next time it starts.
- If your mods and settings can't be read, Flare Tools now restores the copy saved when it last started and tells you, keeping the unreadable file, instead of starting again with nothing.
- Flare Tools now asks before throwing away unsaved changes when you close the mod dialog, choose Undo changes on a Workshop page, or choose Discard in Settings.
- The build output stays responsive during large, noisy builds.
- A toast now tells you when a build finishes while you're in the Workshop tool.
- Buttons that can't be used say why when you hover over them, and icon-only buttons show their names.
- After you check for updates, the update button says when Flare Tools is up to date.
- If downloading a newer update fails, the update already downloaded stays ready to install.
- Screen readers now hear each build step as it runs, finishes or fails, instead of every line of the build log.
- Opening Flare Tools while it's already open now brings the open window forward instead of starting a second copy.
- Save and Discard in Settings are now at the bottom of the window.
- Upload new version now only sends the files and change note, so changes made to the item's page on the Steam website aren't undone.
- A prefix with a drive letter, a ".." or characters Windows doesn't allow in folder names now stops the build with the reason under Packing, and a PBO name containing \ or / can't be saved.
- A mod with two addon folders that would make PBOs with the same name now stops the build and names both folders, instead of one PBO overwriting the other.
- Fixed switching Workshop items while Save page was running losing your edits.
- Fixed trying again after a failed first upload creating a second, empty Workshop item.
- Fixed the Workshop tool staying stuck for hours if Steam closed during an upload.
- Fixed the Workshop page editor closing, and losing its edits, when Steam was briefly unreachable, such as while it restarted.
- Fixed the Workshop counters allowing titles, descriptions and change notes that Steam then rejected when they used accented or non-Latin characters, which Steam counts as more than one.
- Fixed Flare Tools freezing while it read a large mod or a slow network drive, such as while typing a prefix in the mod dialog.
- Fixed signing being reported as failed when the private key's file had been renamed.
- Fixed a P: drive link that couldn't be made leaving an empty folder that blocked every later build of the mod; a mod on a network share now gets a clear explanation.
- Fixed Cancel being ignored when pressed just as a build started.
- Fixed build log lines showing as errors when a file name contained "error", and accented characters sometimes showing as �.
- Fixed an earlier build's log reloading and jumping to the bottom whenever you switched back to Flare Tools.
- Fixed a PBO name left over from when a mod made one PBO showing a red warning that couldn't be cleared; it can now be cleared in Edit, and warnings that don't stop a build show in amber.
- Fixed Open output, View on Steam and other links doing nothing when they couldn't open; they now say why, and http links in the description preview open.
- Fixed the install dialog staying open after Install and restart, and sometimes reopening by itself.
- Fixed an update download that stalled, after the computer slept or changed network, leaving the update button stuck until Flare Tools restarted.
- Fixed long PBO names running over the prefix under Packing.
- Fixed the sidebar footer shifting while an update downloaded, and header buttons such as Build not all being the same height.
- The Flare Tools window now only runs its own code and only reads image files, so content such as a Workshop description can't be used to reach your files.

## 0.1.1 - 2026-10-14

- New Licences section in Settings > About, with the licences for Flare Tools and the parts it ships with.
- If Steam closes or signs out while Flare Tools is open, you can keep working and editing Workshop pages, and publishing comes back once Steam does instead of failing.
- Settings has a cleaner look, with each section on its own card.
- Flare Tools now waits for Steam when it starts: if Steam isn't running or nobody is signed in, it says so, offers Start Steam, and opens by itself once Steam is ready.
- Fixed dropdowns, such as Update channel in Settings > About, opening over their own button instead of below it.

## 0.1.0

- New Build tool: add a mod once with its source folder, output folder and options, then pack it with pboProject in one click (or Ctrl+B), with the log, signing and build history shown as it goes.
- New Workshop tool: create and update your DayZ Steam Workshop items, including the page, preview image and files, which can come straight from a mod's build output.
- New updates: Flare Tools checks for new versions and offers them from the button at the bottom of the sidebar, or from Settings > About, where you can also choose the stable or beta channel.
