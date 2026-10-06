# Repository rulesets (import files)

GitHub keeps rulesets in the repository settings, not in the repository, so these two files change nothing by themselves.
They are the exact settings the project wants, ready to import: Settings, Rules, Rulesets, New ruleset, Import a ruleset.

- `protect-main.json`: nothing reaches the default branch except through a pull request; the branch cannot be deleted or
  force-pushed; review threads must be resolved. Nobody bypasses it, including the owner.
- `protect-release-tags.json`: tags `v*` cannot be created, moved or deleted except by a repository admin (the owner).
  CI cannot rewrite a release tag, and no other contributor can create one that starts the release workflow.

The release workflow only ever creates a DRAFT release (`gh release create --draft`) when a `v*` tag is pushed; publishing
the draft is a manual click by the owner. The update check inside the app asks GitHub for the latest PUBLISHED release, so
a draft is invisible to every user until it is published.

Rulesets on a private repository need a paid GitHub plan; on a public repository they are free. If GitHub refuses to
enforce them while the repository is private, import them when it is made public.
