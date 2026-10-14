# Writing release notes

Follow these when writing or editing release notes, which every version bump needs.

## Where they live

Every version's notes are a section of [`CHANGELOG.md`](../CHANGELOG.md), newest at the top. Despite its name, it
holds release notes for the people using the app, not a record of every change: that record is the git history.

```
## 1.2.0 - 2026-11-14

- New ...
- Fixed ...
```

- The heading is `## ` and the version, then ` - ` and the release date (YYYY-MM-DD). `pnpm bump` adds it for you.
- The build stops if the version in `package.json` has no section, or the section has no bullets.
- The app shows the running version's section in Settings > About, and the release puts it in the update feed so the
  app can show it when the update is offered.
- The GitHub release shows the same notes, followed by a link to every commit since the previous release, added by
  the release script for developers.
- A beta gets its own section (`## 1.2.0-beta.1`) while it is current. When the stable version ships, write its
  section fresh for someone coming from the last stable version, and delete the beta sections: each beta build
  already carries its own notes.

## Format

The app only shows the lines that start with `- `, as plain text in a bulleted list. So:

- One bullet per line, starting with `- `. Headings, blank lines, wrapped lines and anything else are dropped.
- No Markdown inside a bullet: `**bold**`, `` `code` `` and links appear as the raw characters. Write
  Settings > Tools, not **Settings > Tools**.
- There are no category headings. Order the bullets by category instead (see below).

## Writing them

Release notes are for modders using the app, not for the people developing it.

- Describe what changed from the user's point of view: what they can now do, what behaves differently, or what
  problem is gone. Lead with the result, not how it was built.
- Say where to find anything new: in the Build tool's sidebar, next to Build, in Settings > Build defaults.
- Use plain language and the app's own words (button labels, setting names). No internal names, error codes or
  file, class or variable names. Names from DayZ modding that users know, such as pboProject, PBO, prefix or
  .bikey, are fine.
- Keep each bullet to one sentence where practical, with a second only when it adds important context.
- Be specific and factual. No "various improvements" or "general bug fixes" when you know what actually changed.
- Leave out anything users can't notice: refactoring, dependency updates, tests, CI, build and packaging changes.

A change appears once, however much work went into it. Would the user consider this a separate change? If not, merge
it. Don't combine unrelated changes just because they were made together, either.

## Categories and order

Order the bullets in these categories, skipping empty ones, and start each with a word that makes its category clear
where it helps ("New ...", "Fixed ...", "Removed ..."):

1. **Action needed**: changes that need the user to do something. They go first, start with "Action needed:", and
   say what changed, who it affects and what to do, on one line.
2. **Added**: new tools, features or options.
3. **Improved**: existing features that work better, faster or more conveniently.
4. **Changed**: existing behaviour that intentionally works differently, not just better.
5. **Fixed**: describe the problem the user saw, not the bug.
6. **Removed**: say what to use instead, where there is an alternative.
7. **Security**: what users should know, without details that could create a risk.
