# Writing commit messages

Commit messages are public. They describe the change to the project for anyone reading the history.

## Not release notes

The two have different readers:

|          | Commit messages                                                        | Release notes                              |
| -------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| For      | Developers reading the history                                         | Modders using the app                      |
| Says     | What changed in the project and why                                    | What modders can now do or notice          |
| Covers   | Every change, including refactoring, tests, CI, build and dependencies | Only what modders can notice               |
| Wording  | Technical terms, file, command and function names are fine             | No developer terms or internal names       |
| How many | One per change, as it's made                                           | One bullet per feature, written at release |

So a commit message is not a release note bullet, and the other way round. A change modders never see, such as "Move
the release scripts to TypeScript", still needs a clear commit message but gets no release note. How to write release
notes is in [release-notes.md](release-notes.md).

## Format

```
Link the mod onto the P: drive before building

pboProject ignores the prefix in $PBOPREFIX$ and works it out from
where the source sits on P:, so a mod kept anywhere else packed with
the wrong prefix. build.rs now creates a junction at P:\<prefix> for
the build and removes it afterwards.
```

- **Subject:** one line that completes "If applied, this commit will ...". Start with a capitalised verb in the
  imperative ("Add", "Fix", "Rename", "Move"), keep it within 72 characters and leave off the full stop. No prefixes
  such as `CI:` or `fix:`: say "Speed up CI by ...".
- **Body:** optional, after a blank line. Explain why the change was made, since the diff already shows what changed.
  Mention effects and limitations a reader wouldn't guess. Leave it out when the subject says it all.
- Wrap the body at 72 characters. A long URL goes on its own line.
- A GitHub issue goes on the last line of the body, as `Fixes` and its full URL, so it still makes sense outside
  GitHub.

## One change per commit

- One logical change per commit, however many files it touches. A bug fix is one commit, a feature is one commit.
- Keep refactoring separate from changes in behaviour, and unrelated changes in separate commits, even when they're
  small or made together.
- An "and" in the subject is a hint that the commit does two things. Keep it only when both halves are one change.

## Writing them

- Be specific, so the subject means something on its own: "Fix Build staying disabled after a cancelled build", not
  "Fix bug" or "Update stuff".
- Name code the way developers will search for it: files, commands, functions, settings.
- No details of a particular computer: no local paths, folder names, machine setup or where something lives on disk.
  "Find DSSignFile in every Steam library folder", not "Look for DSSignFile on drive D".
- Commits are authored by CallMeLewis alone, with no co-author trailers.
- Don't amend or rewrite commits that have been pushed. Fix them with a new commit.

## Releases

A release commit only bumps the version and adds its `CHANGELOG.md` section. Its subject is `Release`, the version
and a short summary of what's in it, never the bare version number:

```
Release 0.1.1: wait for Steam, settings polish and licences
```

## Final check

- Does the subject complete "If applied, this commit will ...", start with a capital and stay within 72 characters,
  with no prefix or full stop?
- Is there a blank line between the subject and the body?
- Does the body explain why, rather than retell the diff?
- Does the commit hold one change, with refactoring and unrelated fixes split out?
- Is it free of local paths and machine details?
