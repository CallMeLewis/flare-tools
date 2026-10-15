# Flare Tools design

The visual rules the app follows. It's a desktop utility for working on mods, not a marketing site: no landing-page
sections, hero art or scroll animations.

## Style

shadcn/ui on Base UI with the neutral palette, in light and dark themes. The theme switch in the sidebar footer and
Settings > Appearance pick Light, Dark or System (the default, following Windows). Flat surfaces separated by 1px
borders. Only things that float over the page, such as menus, dialogs, tooltips and toasts, get a shadow.

The app draws its own title bar (`title-bar.tsx`): the app name, the tools, and Windows' minimise, maximise and close
buttons.

## Colour

Tokens live in `src/index.css`. Use the tokens, never raw colours in components. Light is the `:root` set and dark
the `.dark` set; the class goes on `<html>`.

| Role | Use |
|---|---|
| background | The page behind a tool's content |
| sidebar | Title bar, mod and item lists, settings navigation |
| card | Grouped content on a page, such as the build output |
| popover | Menus, dialogs, rich tooltips |
| muted / accent | Hover and selected surfaces, code and log backgrounds |
| border | Dividers and card edges |
| input | Field edges |
| foreground | Primary text |
| muted-foreground | Secondary text, paths, hints |
| primary | The main action on a page (Build, Save), selection |
| success | Built, found, done |
| warning | Changed since last build, work in progress |
| info | Building |
| destructive | Failed, missing, blocked, and actions that remove things |
| window-close | The title bar's close button on hover, in Windows' red whatever the theme |
| overlay | A scrim over a picture, to show a control on top of it |

Primary is near-black in light and near-white in dark: the app has no brand colour, so colour is kept for status.
Status colours are the 700 steps in light (5:1 or better on white) and the lighter 400 steps in dark. Colour never
carries meaning alone: a status dot always sits next to a label that says the same thing.

## Typography

- Geist (variable) for interface text, bundled through `@fontsource-variable`. The app makes no font requests.
- 14px (`text-sm`) for body text and controls, 12px (`text-xs`) for secondary lines and labels, 16px semibold for
  page titles.
- `font-mono` for anything a modder might copy or compare: paths, prefixes, versions, Steam IDs, build logs and
  BBCode. No mono font is bundled, so it falls back to Windows' Consolas.
- Data the user may want to copy opts back in to selection with `select-text`. The rest of the interface can't be
  selected, like a native app.

## Layout and density

- Window 1180×760 by default, minimum 920×600.
- Title bar 44px. Each tool has a 304px sidebar list on the left, with Settings, the theme switch and the update
  button pinned to its foot, and its content on the right.
- Page headers are 64px with 24px side padding, and hold the page's actions on the right.
- Controls are 32px tall (the `default` button size). Buttons side by side share a size; the main action stands out
  by colour, not by size. The sidebar footer's icon buttons are 36px (`icon-lg`).
- 8px gaps between controls, 16px padding around the main content.
- Settings > Appearance sets the interface size from 90% to 150%. It zooms the whole webview, so layouts are in CSS
  pixels and grow with it.

## Components

- Use the components in `src/components/ui` before writing new ones, and keep their look: change what a component is
  for, not how it's styled.
- Icons are Lucide, 16px in buttons and 20px on their own in the sidebar footer.
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
