# Flare Tools design

The visual rules the app follows. It's a desktop utility for working on mods, not a marketing site: no landing-page
sections, hero art or scroll animations.

## Style

The Flare apps' shared look, from `@flare/ui` in the flare-common repo beside this one (see
[development.md](development.md)), so Flare Tools looks and works like Flare Launcher and Flare Navgen. Light and dark
themes: Settings > Appearance picks Light, Dark or System (the default, following Windows). Flat surfaces separated by
1px borders. Only things that float over the page, such as menus, dialogs, tooltips and toasts, get a shadow.

The app draws its own title bar, the shared `TitleBar`: the app's mark and name, and Windows' minimise, maximise and
close buttons. The tools are pages in the shared sidebar, `AppSidebar`, with Settings and the update button at its
foot.

## Colour

The tokens are the Flare apps' shared ones, in `packages/ui/src/theme.css` in flare-common; change them there, so every
app changes together. `src/index.css` adds only this app's own. Use the tokens, never raw colours in components.
Light is the `:root` set and dark the `.dark` set; the class goes on `<html>`.

| Role | Use |
|---|---|
| background | The page behind a tool's content |
| card | Title bar, sidebar, the mod and item lists, and grouped content on a page, such as the build output |
| popover | Menus, dialogs, rich tooltips |
| muted / accent | Hover and selected surfaces, code and log backgrounds |
| border | Dividers and card edges |
| input | Field edges |
| foreground | Primary text |
| muted-foreground | Secondary text, paths, hints |
| primary | The main action on a page (Build, Save), selection |
| success | Built, found, done |
| warning | Changed since last build, work in progress |
| info | Building (this app's own) |
| destructive | Failed, missing, blocked, and actions that remove things |
| brand | The orange of the app's icon, behind its mark in the title bar (this app's own) |
| overlay | A scrim over a picture, to show a control on top of it (this app's own) |

Primary is the Flare apps' green. Orange is only the app's mark, so colour stays free for status. Light values keep
text at WCAG AA (4.5:1) on every surface, which is why primary and the status colours are a shade darker than in dark.
Colour never carries meaning alone: a status dot always sits next to a label that says the same thing.

## Typography

- Fira Sans for interface text and Fira Code for `font-mono`, both bundled by the shared theme. The app makes no font
  requests.
- 14px (`text-sm`) for body text and controls, 12px (`text-xs`) for secondary lines and labels, 16px semibold for
  page titles.
- `font-mono` for anything a modder might copy or compare: paths, prefixes, versions, Steam IDs, build logs and
  BBCode.
- Data the user may want to copy opts back in to selection with `select-text`. The rest of the interface can't be
  selected, like a native app.

## Layout and density

- Window 1180×760 by default, minimum 920×600.
- Title bar 32px. The sidebar is 224px, and below 1280px it folds to 56px of icons.
- Each tool's page (`ToolPage`) has a 64px header across its full width, with 16px side padding and the page's
  actions on the right. Below it, the list (Mods, Workshop items) is a 288px card on the left, beside the page's other
  cards.
- Controls are 36px tall (the `default` button size). Buttons side by side share a size; the main action stands out
  by colour, not by size.
- 8px gaps between controls, 16px padding and gaps around and between cards.
- Settings > Appearance sets the interface size from 90% to 150%. It zooms the whole webview, so layouts are in CSS
  pixels and grow with it, and the sidebar folds sooner.

## Components

- Use the shared components before writing new ones: the base ones from `@flare/ui/ui/*` (buttons, dialogs, fields,
  menus and so on), and the shell, settings and update parts from `@flare/ui`. The few that are only this app's are
  in `src/components/ui`. Keep their look: change what a component is for, not how it's styled. Something every Flare
  app could use belongs in flare-common.
- Icons are Lucide, 16px in buttons and 20px on their own in the sidebar's foot.
- Icon-only buttons have an `aria-label` and a tooltip. A tooltip shows the keyboard shortcut, if there is one, with
  `Kbd`.

## Interaction

- Every interactive element has a visible focus ring and a hover state, with colour transitions. Respect
  `prefers-reduced-motion` (`motion-reduce:` / `motion-safe:`) for spinning, pulsing and gliding.
- Keyboard shortcuts for the common jobs: Ctrl+1, Ctrl+2 to switch tools, Ctrl+B to build.
- A disabled action says why, through `DisabledHint`, rather than just greying out.
- Truncated text exposes the full value through `title`.
- Loading shows a spinner where the content will be. Empty states say what's missing and offer the next action.
- Toasts are for things that happen out of view, such as a build finishing for a mod that isn't open, or Steam
  closing. A result the user is already looking at isn't repeated in a toast.
- Removing or throwing away anything asks first, in an alert dialog that names what will be lost.

## Words

- British English: colour, licences, minimise.
- Sentence case for titles, labels and buttons. Buttons say what they do: "Add a mod", "Upload new version".
- Use the names modders know from DayZ modding, such as pboProject, PBO, prefix, P: drive and .bikey, and nothing
  internal to the app.
