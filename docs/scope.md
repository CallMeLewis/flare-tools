# What Flare Tools is for

Read this before adding a feature. The app stays small on purpose: every feature has to be built, tested against the
tools it drives and kept working as those tools and Steam change, so each one costs more than it first appears to.

## The core

Flare Tools helps a DayZ modder **build, sign and publish their mods**. Everything it does should serve one of those
three steps:

- **Build:** adding a mod once, working out its prefix and PBOs, linking it onto the P: drive, packing it with
  pboProject, the build log and history, and building every changed mod at once.
- **Sign:** signing each PBO with DSSignFile, choosing the key, and putting the `.bikey` in the mod's `keys` folder.
- **Publish:** creating and updating Steam Workshop items: the page, preview image, files and change notes, and the
  item's stats.

Around that sits what any desktop app needs: updating itself, themes, interface size, finding the tools on first run
and waiting for Steam.

## What it won't do

These ideas come up, and the answer is no unless this document is changed first:

- No editing of a mod's content: no script, config, model or texture editors. Modders already have their own tools for
  that.
- No packer or signer of its own. Flare Tools drives pboProject and DSSignFile, which modders already trust, rather
  than replacing them.
- No playing DayZ, browsing servers or joining them. That's Flare Launcher.
- No server hosting, administration, RCON or server configuration.
- No accounts, sign-in or online storage of its own. Steam is the only account it uses.
- No sharing or syncing mods between people or computers. Git and the Workshop already do that.
- No publishing anywhere other than the Steam Workshop.
- No support for games other than DayZ.
- No telemetry or usage tracking.
- No versions for other systems. DayZ Tools, pboProject and the P: drive are Windows-only, so the app is too.

## Questions to ask of a new feature

1. **Does it help a modder build, sign or publish a mod?** If not, it needs a strong reason, and probably doesn't
   belong.
2. **Would modders notice if it were missing?** Requests and problems modders actually report count for more than
   ideas that would be nice to have.
3. **Can it live in something that already exists?** An option on a mod, a line in the build output or a field on the
   Workshop page is better than a new tool, page, dialog or toolbar button.
4. **Does it need a setting?** Prefer a good default, or work it out from the mod as prefixes are. Each setting is a
   decision handed to the modder and another combination to test. Add one only when modders genuinely want different
   things.
5. **What does it cost to keep?** Count the code, the outside tools and services it depends on (pboProject, DayZ
   Tools, Steam), and what breaks when one of them changes.
6. **Is it the simplest version that works?** Ship the smallest useful form first and grow it only when modders ask.

A feature that fails the first question, or needs more than one of the others explained away, isn't added.

## Looking back

Features that are already there are not kept just because they exist. When one is rarely used, keeps breaking, or
costs more to maintain than it gives modders, consider simplifying or removing it, with a release note saying what to
use instead.

Not every release needs something new. Releases of fixes, speed and clearer wording alone make the app better without
making it bigger.
