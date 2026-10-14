# Third-party components

Flare Tools' own code is under the GNU General Public License v3 (see [LICENSE](LICENSE)). It also ships these
components, which keep their own licences.

## Steamworks API

`src-tauri/steam_api64.dll` is the Steamworks API redistributable from Valve Corporation, copied from the
[`steamworks-sys`](https://crates.io/crates/steamworks-sys) crate. It is not covered by the GPL. It is included so the
Workshop tool can publish items through the Steam client, and is distributed under Valve's Steamworks SDK terms. Steam
and Steamworks are trademarks of Valve Corporation.

## Fonts

The app uses Geist, under the SIL Open Font License 1.1. Its licence text is in `licenses/OFL-geist.txt`.

- Geist: Copyright 2024 The Geist Project Authors.

## Libraries

The Rust and JavaScript libraries the app is built with, such as Tauri, React and Base UI, are listed in
`src-tauri/Cargo.toml` and `package.json` (and in full in `src-tauri/Cargo.lock` and `pnpm-lock.yaml`). Almost all use
permissive licences such as MIT, Apache 2.0, ISC, BSD or Zlib; a few use the Mozilla Public License 2.0 or the Unicode
and CDLA-Permissive data licences. All of them are compatible with the GPL v3.

## Tools it runs

Flare Tools doesn't include Mikero's tools (pboProject) or Bohemia Interactive's DayZ Tools (DSSignFile). It runs the
copies you have installed, which stay under their own licences.
