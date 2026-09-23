# vcs-protection: technical documentation

This is the full reference for `vcs-protection`: what it protects, how each part works, every command, option, configuration field and environment variable, and how to develop and release it. For a short introduction see [README.md](README.md); for the pre-publish end-to-end test procedure see [Workflow.md](Workflow.md).

## Contents

1. [Overview](#1-overview)
2. [Concepts and threat model](#2-concepts-and-threat-model)
3. [Requirements](#3-requirements)
4. [Installation and automatic setup](#4-installation-and-automatic-setup)
5. [Configuration file](#5-configuration-file-vcs-protectionjson)
6. [How the effective rules are found](#6-how-the-effective-rules-are-found)
7. [The rule engine](#7-the-rule-engine)
8. [Git hooks](#8-git-hooks)
9. [Block messages](#9-block-messages)
10. [Emergency bypass and the audit log](#10-emergency-bypass-and-the-audit-log)
11. [Command reference](#11-command-reference)
12. [The GitHub Actions guard](#12-the-github-actions-guard)
13. [GitHub API access](#13-github-api-access)
14. [Environment variables](#14-environment-variables)
15. [Files and locations](#15-files-and-locations)
16. [Exit codes](#16-exit-codes)
17. [Limitations](#17-limitations)
18. [Troubleshooting](#18-troubleshooting)
19. [Architecture and source map](#19-architecture-and-source-map)
20. [Development and release](#20-development-and-release)

---

## 1. Overview

`vcs-protection` adds branch protection to git repositories when GitHub's server-side branch protection is not available (for example, private repositories on plans that don't include it). It enforces one policy:

> Changes reach a protected branch only through a pull request with enough approvals.

It does this on two layers:

| Layer | Where it runs | What it does |
|---|---|---|
| **Local git hooks** | Every teammate's clone | Refuse commits, merges, cherry-picks, rebases, resets and pushes that would change a protected branch. This includes `git commit --no-verify`, through the `reference-transaction` hook. |
| **GitHub Actions guard** | On GitHub, on every push to a protected branch and on PR events | Accept a push to a protected branch only if it is the merge commit of a PR with enough approvals. Otherwise save the commits to a rescue branch, reset or delete the branch, and open an issue. Also posts an approvals status on PRs. |

The package is a single Node.js CLI (`vcs-protection`). The git hooks are small POSIX shell scripts ("shims") that call the CLI. The GitHub guard is a generated workflow that runs the same CLI with `npx`.

---

## 2. Concepts and threat model

- **Protected branch:** a branch whose name matches a `pattern` in the configuration (`main`, `release/*`, …).
- **The remote:** the shared repository (`origin` by default, configurable with `remote`). Protection is defined relative to what is already on the remote.
- **Effective rules:** the rules that currently apply. They are read from the remote's default branch, not from your working tree (see [section 6](#6-how-the-effective-rules-are-found)). Changing the rules therefore requires a reviewed PR as well.
- **Bypass:** a logged, per-command escape hatch (`VCS_PROTECTION_BYPASS="<reason>"`) for emergencies and for the one-time bootstrap.

**What it defends against:** honest mistakes and shortcuts: committing on `main` by accident, `--no-verify`, fast-forward merging locally and pushing, force-pushing, merging a PR in the GitHub UI without approval, deleting a protected branch.

**What it doesn't defend against:** a determined teammate with write access. Local hooks can be removed, and a direct push that also deletes the guard workflow isn't checked (see [Limitations](#17-limitations)). These are guardrails, not a security boundary. The `audit` command exists to detect what slipped through.

---

## 3. Requirements

| Requirement | Why |
|---|---|
| **git ≥ 2.28** | The `reference-transaction` hook, which `--no-verify` can't skip. `init`, `doctor` and the automatic setup check this. Git for Windows is supported (hooks run through its bundled `sh`). |
| **Node.js ≥ 22.12** | Runtime of the CLI (`engines.node`). |
| **npm** | Installation. npm ≥ 12 needs a one-time approval for the automatic setup ([4.3](#43-npm-12-and-install-script-approval)). |
| **GitHub** (optional) | For the Actions guard, automatic PR creation, and `audit`. Other hosts get the local hooks only. |

---

## 4. Installation and automatic setup

The package has an npm `postinstall` lifecycle script. The script configures git hooks by itself, so developers normally don't have to run `vcs-protection init` or `vcs-protection install --global`. What it does depends on how the package was installed.

### 4.1 As a project dependency (recommended for Node.js projects)

The team lead adds the package once and commits `package.json` (and the lock file):

```sh
npm i -D vcs-protection
npm install-scripts approve vcs-protection   # npm >= 12 only, see 4.3
```

From then on, every `npm install` / `npm ci` in any clone of the project:

1. finds the git repository that contains `INIT_CWD` (the directory where `npm install` was run; npm sets this variable for lifecycle scripts). Running npm in a subdirectory of the repository works too;
2. reads the effective rules, to take the `failMode` from them (`open` when there are no rules yet, or when they can't be read);
3. installs, or refreshes, the six hook shims in that repository's hooks directory (honouring `core.hooksPath`, and chaining any existing non-vcs-protection hook as `<hook>.local`);
4. prints what it did. If the repository has no `.vcs-protection.json` yet, it adds that the hooks stay inactive until one exists.

The shims point at the project's own copy: `<repo>/node_modules/vcs-protection/dist/cli.js`. Consequences:

- Every developer gets the version of the CLI that the project pins. Nothing has to be installed globally.
- Upgrading the dependency and running `npm install` again refreshes the hooks, because they are rewritten on every install.
- Run commands with `npx vcs-protection …` in such a project. The global CLI (if any) sees the hooks as `outdated`, because `status`/`doctor` compare the hooks with the CLI that runs them. Don't run a global `doctor --fix` there: it would repoint the hooks at the global CLI.
- The automatic setup never creates a config file and never prompts. Creating the rules is still done once, by one person, with `npx vcs-protection init`.

### 4.2 As a global package

```sh
npm i -g vcs-protection
```

A global install doesn't touch any repository. It configures git's `init.templateDir` instead, exactly like `vcs-protection install --global`:

- It writes the six shims to `~/.vcs-protection/git-template/hooks/` (with `failMode` `open`), and sets `git config --global init.templateDir ~/.vcs-protection/git-template`.
- From then on, every `git clone` and `git init` copies the shims into the new repository. They do nothing in repositories without a `.vcs-protection.json`.
- If `init.templateDir` is **already set to a different directory**, the install leaves it unchanged and prints how to replace it (`vcs-protection install --global --force`), or to use `vcs-protection init` per clone instead.
- Clones that already exist aren't changed. Run `vcs-protection init` in them (or `git init` inside them, which copies the template's hooks).

Global installs are detected through npm's environment (`npm_config_global=true` or `npm_config_location=global`).

### 4.3 npm 12 and install-script approval

npm handles dependency install scripts differently depending on its version:

| npm version | Behaviour |
|---|---|
| ≤ 10 | Runs the script. |
| 11 | Runs the script, and prints `npm warn install-scripts … not yet covered by allowScripts`. |
| ≥ 12 | **Skips** the script unless the package is approved, and prints `… had install scripts blocked …`. |

Approving the package:

- **Project dependency:** run `npm install-scripts approve vcs-protection` once. It adds an entry to the `allowScripts` field of `package.json`. Commit it, and every teammate's install runs the script. (For a tarball or `file:` dependency, the entry names the `file:` spec instead of `vcs-protection`.)
- **Global install:** `npm i -g --allow-scripts=vcs-protection vcs-protection`, or permanently `npm config set allow-scripts=vcs-protection --location=user`. The `--allow-scripts` flag is refused for installs inside a project; there, use `allowScripts` in `package.json`.

If the script doesn't run, nothing breaks: set the hooks up manually with `vcs-protection init` (4.5).

### 4.4 When the automatic setup does nothing

The script exits successfully without changing anything when:

| Condition | Reason |
|---|---|
| `VCS_PROTECTION_SKIP_INSTALL` is set to anything other than empty, `0` or `false` | Explicit opt-out. |
| `CI` is set to anything other than empty, `0` or `false` | CI runners don't need hooks. It also keeps the GitHub guard's `npx vcs-protection@… ci-guard` from writing hooks into the runner's checkout. |
| `dist/cli.js` doesn't exist next to the script | A fresh checkout of vcs-protection's own repository, before the first build. |
| `INIT_CWD` isn't inside a git working tree | Nothing to install into. A note is printed. |
| The repository that would receive the hooks is vcs-protection's own repository (the package directory isn't inside `node_modules`) | Developing vcs-protection itself must not install hooks into it. |
| git is older than 2.28 | A warning is printed. |
| npm ran with `--ignore-scripts` (or `ignore-scripts=true` in `.npmrc`), or npm ≥ 12 without approval | npm doesn't run the script at all. |

The script **never fails `npm install`**. Every error (for example an unwritable hooks directory) becomes a warning:

```
[vcs-protection] Automatic setup skipped: EACCES: permission denied, open '…/.git/hooks/reference-transaction'
[vcs-protection] Run `vcs-protection init` in your repository to install the hooks manually.
```

npm ≥ 7 hides the output of dependency install scripts. Use `npm install --foreground-scripts` to see it, or check the result afterwards with `npx vcs-protection status`.

### 4.5 Manual setup

The automatic setup is optional. The manual commands are unchanged:

- `vcs-protection init` in a clone: creates the config if missing (only needed once per repository), and installs the hooks in that clone.
- `vcs-protection install --global`: once per machine; same effect as 4.2. `--force` replaces a foreign `init.templateDir`.

### 4.6 Removing the hooks

npm (since v7) runs no scripts on `npm uninstall`, so **removing the package doesn't remove the hooks**. Remove them first:

```sh
npx vcs-protection uninstall            # this clone (restores chained *.local hooks)
vcs-protection uninstall --global       # the global template and init.templateDir
```

Hooks that outlive their CLI fall back to a `vcs-protection` found on `PATH`. If there is none, they print `CLI not found: branch protection is NOT active` and then follow `failMode` (allow with `open`, block with `closed`).

### 4.7 Bootstrapping a new repository (team lead, once)

```sh
npx vcs-protection init --branches "main,release/*" --approvals 1 --github
git switch -c chore/vcs-protection
git add .vcs-protection.json .github/workflows/vcs-protection-guard.yml
git commit -m "Add branch protection rules"
git push -u origin chore/vcs-protection    # then open and merge a PR
```

If the remote is empty (nothing to open a PR against), bootstrap once with the bypass:

```sh
VCS_PROTECTION_BYPASS="initial setup" git commit -m "Add branch protection"
VCS_PROTECTION_BYPASS="initial setup" git push
```

On GitHub, set **Settings → Actions → General → Workflow permissions** to **Read and write permissions**. The guard needs it to revert pushes, create branches and open issues.

---

## 5. Configuration file: `.vcs-protection.json`

The file lives at the repository root and is committed. It is validated with a strict schema; unknown values for enums, negative numbers or a wrong `version` are reported with the path of each problem:

```
.vcs-protection.json: invalid configuration
  - protected.0.requiredApprovals: Too small: expected number to be >=0
```

### 5.1 Full example

```json
{
  "version": 1,
  "remote": "origin",
  "protected": [
    { "pattern": "main", "requiredApprovals": 1, "allowDeletion": false },
    { "pattern": "release/*", "requiredApprovals": 2, "allowDeletion": false }
  ],
  "bypass": { "allowed": true },
  "github": {
    "enforcement": "revert",
    "rescueBranchPrefix": "vcs-protection/rescue/",
    "bypassUsers": []
  },
  "failMode": "open"
}
```

### 5.2 Field reference

| Field | Type | Default | Meaning |
|---|---|---|---|
| `$schema` | string | – | Optional; ignored. Lets editors attach a schema. |
| `version` | `1` | **required** | Format version. Only `1` is accepted. |
| `remote` | string | `"origin"` | The remote that represents the shared repository. Rules are read from its default branch, pushes to other remotes are not checked, and "already on the remote" means on `refs/remotes/<remote>/<branch>`. |
| `protected` | array of rules | `[]` | Protected branch rules (below). |
| `protected[].pattern` | string, non-empty | **required** | Branch name or glob (see 5.3). |
| `protected[].requiredApprovals` | integer ≥ 0 | `1` | Approvals a PR needs for its merge to be kept by the guard. `0` still requires the change to come from a merged PR. |
| `protected[].allowDeletion` | boolean | `false` | Whether the branch may be deleted on the remote (`git push origin :branch`, deleting on GitHub). Deleting the *local* branch is always allowed. |
| `bypass.allowed` | boolean | `true` | Whether `VCS_PROTECTION_BYPASS` works in the local hooks. Has no effect on the GitHub guard. |
| `github.enforcement` | `"revert"` \| `"report"` | `"revert"` | What the guard does on a violation. `revert`: save the commits to a rescue branch, reset/delete/restore the branch, open an issue. `report`: only open the issue. |
| `github.rescueBranchPrefix` | string, non-empty | `"vcs-protection/rescue/"` | Prefix of rescue branches. The full name is `<prefix><branch>-<sha7>`. |
| `github.bypassUsers` | string[] | `[]` | GitHub logins whose pushes and deletions the guard accepts without checks (for example release managers or bots). |
| `failMode` | `"open"` \| `"closed"` | `"open"` | What hooks do when the CLI is missing or crashes. `open` warns and allows the operation; `closed` blocks it. |

### 5.3 Patterns

Patterns are matched against the short branch name (`release/1.0`, not `refs/heads/release/1.0`) with [picomatch](https://github.com/micromatch/picomatch) (`dot: true`):

| Pattern | Matches | Doesn't match |
|---|---|---|
| `main` | `main` | `main2`, `feature/main` |
| `release/*` | `release/1.0` | `release/1.0/hotfix`, `release` |
| `release/**` | `release`, `release/1.0`, `release/1.0/hotfix` | `releases/1.0` |
| `{main,develop}` | `main`, `develop` | |
| `hotfix-*` | `hotfix-123` | `hotfix/123` |

When several rules match a branch, the **first** one in the array wins. `protect` appends new and changed rules to the end, so put more specific patterns first if you edit the file by hand.

### 5.4 Changing the configuration

Use `protect` / `unprotect` (they also regenerate the workflow's branch list and open a PR), or edit the file on a branch and open a PR yourself. A change takes effect for everyone only after it is merged into the default branch and fetched. After a hand edit, also run `vcs-protection github setup` so the workflow's `push.branches` filter matches the new patterns; `doctor` reports when they differ.

---

## 6. How the effective rules are found

Every command and hook loads the rules the same way:

1. Read the working-tree `.vcs-protection.json`, if present, only to learn the `remote` name (default `origin`).
2. Find the remote's default branch: `refs/remotes/<remote>/HEAD`, else `refs/remotes/<remote>/main`, else `refs/remotes/<remote>/master`.
3. If that ref has a `.vcs-protection.json`, use it (`source: remote`, location `refs/remotes/origin/main:.vcs-protection.json`).
4. Otherwise, use the working-tree file (`source: local`). This covers the initial setup before the rules are merged, and repositories without a remote.
5. Otherwise there are no rules: hooks do nothing, and commands that need rules ask you to run `init`.

Why the remote copy wins: a teammate who relaxes the rules on a feature branch (or deletes the file) changes nothing, because the hooks keep reading the reviewed copy from `origin/main`. Rules change for everyone only after the PR is merged and fetched.

The GitHub guard uses the same idea on the server: a push is judged by the configuration **as it was before the push** (at `before`, or at the default branch for newly created branches), so a push can't disable its own check.

---

## 7. The rule engine

The engine (`src/rules/evaluate.ts`) is pure: it takes a ref update, the configuration, and a small set of repository queries, and returns `allow`, `block` or `bypass`.

### 7.1 Local ref updates (reference-transaction)

Central rule: **a protected branch may only move to commits that already exist on the remote's copy of that branch.** For each updated ref, in order:

| Check | Result |
|---|---|
| Not under `refs/heads/` (tags, remote-tracking refs, `HEAD`, …) | allow |
| Branch doesn't match any rule | allow |
| New value is all zeros (local branch deleted) | allow |
| Old value = new value | allow |
| New commit is the tip of, or an ancestor of, `refs/remotes/<remote>/<branch>` | allow (sync) |
| Branch is being **created** and the new commit is reachable from the remote default branch | allow (e.g. `git switch main` from a tracking branch, `git branch release/2 origin/main`) |
| Branch is being created from anything else | block `create` |
| Old commit is an ancestor of the new one (new commits on top) | block `advance` |
| Anything else (history moved sideways or backwards) | block `rewrite` |

Refs updated earlier in the same transaction are taken into account (for example `git pull`, where `origin/main` and `main` move together, or `git fetch` + checkout in one go).

**Allowed examples:** `git pull` (fast-forward), `git pull --rebase` with no local commits, `git reset --hard origin/main`, `git switch main`, creating a protected branch from `origin/main`, deleting a local protected branch.

**Blocked examples:** `git commit` and `git commit --no-verify` on `main`, `git merge feature` (fast-forward or not), `git cherry-pick`, `git rebase` onto local-only commits, `git reset --hard feature`, `git branch -f main feature`, `git revert` on `main`, creating `release/9` from unpushed commits.

### 7.2 Pushes (pre-push)

For each ref being pushed:

| Check | Result |
|---|---|
| The push goes to a remote other than `remote` | allow |
| Target isn't a branch, or isn't protected | allow |
| Local and remote values are equal | allow |
| Push deletes the branch and the rule has `allowDeletion: true` | allow |
| Push deletes the branch | block `push-delete` |
| Any other push to a protected branch | block `push` |

So *every* push to a protected branch is refused locally, even a fast-forward. Changes must arrive through a PR merged on GitHub.

### 7.3 Bypass

A `block` becomes `bypass` when `bypass.allowed` is `true` and `VCS_PROTECTION_BYPASS` is set to a non-blank value. See [section 10](#10-emergency-bypass-and-the-audit-log).

---

## 8. Git hooks

### 8.1 Installed hooks

| Hook | Receives | Role | Can block? |
|---|---|---|---|
| `reference-transaction` | state argument (`prepared`, `committed`, `aborted`), ref updates on stdin | The real enforcement (section 7.1). Runs for every ref change, including `--no-verify` commits. Acts only in the `prepared` state. | yes |
| `pre-commit` | – | Early, friendly block before the commit message editor opens. Skipped by `--no-verify` (reference-transaction still catches it). | yes |
| `pre-merge-commit` | – | Same for merge commits. | yes |
| `pre-push` | remote name and URL; `<local ref> <local sha> <remote ref> <remote sha>` lines on stdin | Section 7.2. Skipped by `git push --no-verify` (then the GitHub guard catches it). | yes |
| `post-checkout` | – | Self-repair: reinstalls shims that are missing or outdated. | never |
| `post-merge` | – | Self-repair, same as post-checkout. | never |

`pre-commit` and `pre-merge-commit` also honour the bypass. They stay silent on branches that aren't protected and while HEAD is detached.

### 8.2 The shim

Every hook is a small POSIX `sh` script, generated by `renderShim` (`src/hooks/shim.ts`). It starts with the marker `# vcs-protection:managed`, which is how vcs-protection recognises its own files. It embeds:

- `VCSP_NODE`: the absolute path of the Node binary that installed it;
- `VCSP_CLI`: the absolute path of the CLI (`…/dist/cli.js`) that installed it: the global install, the project's `node_modules` copy, or `VCS_PROTECTION_CLI_PATH` if set;
- `VCSP_FAIL`: the `failMode` at install time.

When git runs the hook:

1. **Relevance gate** (pure shell, no Node): the hook continues only if the repository has `.vcs-protection.json` in the working tree, or on `origin/HEAD`, `origin/main` or `origin/master`. That keeps the global template cheap in unrelated repositories. (The gate checks the `origin` remote; the full rule loading in Node uses the configured `remote`.)
2. For `reference-transaction`, Node is started only in the `prepared` state **and** only if a `refs/heads/` ref is involved, so `git fetch` never pays the Node start-up cost.
3. **Run the CLI:** `"$VCSP_NODE" "$VCSP_CLI" hook <name> <args>`. If either file is gone, it falls back to `vcs-protection` on `PATH`. If there is none, it prints `CLI not found: branch protection is NOT active…` and allows (`open`) or blocks (`closed`).
4. **Chained hook:** if `<hook>.local` exists next to the shim, it runs next, with the same arguments and stdin. Its exit code is passed on.

Stdin is read once and passed to both the CLI and the chained hook. The advisory hooks (`post-checkout`, `post-merge`) never fail because of vcs-protection.

On Windows, paths are written with forward slashes, and Git for Windows runs the shims through its bundled `sh`.

### 8.3 Chaining existing hooks

When a hook file that isn't managed by vcs-protection already exists (husky, lefthook, a hand-written hook…), the installer renames it to `<hook>.local` and writes the shim in its place; the shim then calls it. If both `<hook>` and `<hook>.local` already exist, that hook is left untouched and a warning is printed. `uninstall` removes the shim and renames `<hook>.local` back.

If `core.hooksPath` is set (as husky does), the hooks go into that directory, and the existing hooks there are chained in the same way. `init`, `doctor` and the automatic setup mention it.

### 8.4 Hook states

`status` and `doctor` report each hook as:

| State | Meaning |
|---|---|
| `installed` | The file is exactly what this CLI would write now. |
| `outdated` | A vcs-protection shim, but different: another CLI path or Node path, another `failMode`, or an older version of the package. |
| `missing` | No file. |
| `foreign` | A file without the managed marker (not ours, and not chained). |

`post-checkout` and `post-merge` repair `missing` and `outdated` hooks automatically (printing `Repaired git hooks: …`). `doctor --fix` does the same on demand. Neither touches `foreign` hooks.

### 8.5 Internal failures

If the CLI throws while running a hook (for example an invalid config on the remote), it prints `Internal error in <hook> hook: …` and then follows `failMode`: `open` allows the operation, `closed` blocks it.

---

## 9. Block messages

When a hook blocks something, it prints a red box on stderr that explains what happened and what to do instead. The message depends on what was attempted:

| Situation | Title | Guidance |
|---|---|---|
| Commit on a protected branch (`pre-commit`, or `advance` with no source branch) | `Direct commits to protected branch 'main' are not allowed.` | `git switch -c <feature-branch>`; abort hints for cherry-pick / revert / rebase in progress |
| Merge into a protected branch (`pre-merge-commit`, a merge in progress, or `advance` whose commits come from a local branch) | `Merging into protected branch 'main' is not allowed.` | Push the source branch, compare link to open a PR, `git merge --abort` |
| `rewrite` | `Rewriting protected branch 'main' is not allowed.` | `git fetch && git reset --hard origin/main`; `git rebase --abort` |
| `create` | `Creating protected branch 'x' from local-only commits is not allowed.` | Create it from a remote commit, e.g. `git branch x origin/main` |
| `push` | `Pushing directly to protected branch 'main' is not allowed.` | `git push -u origin HEAD:<feature-branch>` and a PR link |
| `push-delete` | `Deleting protected branch 'main' is not allowed.` | – |

Details:

- The approvals sentence reflects the rule: "approved by 2 other team members", or just "a pull request on GitHub" for `requiredApprovals: 0`.
- With a GitHub remote, messages include a ready-made compare link: `https://github.com/<owner>/<repo>/compare/<base>...<head>?expand=1`.
- **Working tree already moved:** for fast-forward merges and `reset --hard`, git updates the index and files *before* the ref, so after the block your files show the new commit while the branch didn't move. The message then adds the exact command to put them back without losing other local edits: `git read-tree -m -u <sha12> HEAD`.
- If bypass is allowed, the last line reminds you of the emergency bypass.

---

## 10. Emergency bypass and the audit log

```sh
VCS_PROTECTION_BYPASS="hotfix for incident 42" git commit -m "…"
VCS_PROTECTION_BYPASS="hotfix for incident 42" git push origin main
```

PowerShell:

```powershell
$env:VCS_PROTECTION_BYPASS = "hotfix for incident 42"; git push origin main; Remove-Item Env:VCS_PROTECTION_BYPASS
```

- Works only if `bypass.allowed` is `true` in the effective rules, and the reason is not blank.
- Each bypassed ref update is **allowed**, prints `Protection bypassed for 'main' (VCS_PROTECTION_BYPASS="…"). This was logged.`, and is appended to the audit log.
- It only affects the local hooks. The GitHub guard still judges the push, and reverts it unless the pusher is in `github.bypassUsers`.

The audit log is `<git common dir>/vcs-protection/audit.log` (normally `.git/vcs-protection/audit.log`; shared by all worktrees). It is local, not committed. One JSON object per line:

```json
{"time":"2026-09-24T10:00:00.000Z","user":"Alice <alice@example.com>","hook":"reference-transaction","kind":"advance","ref":"refs/heads/main","oldSha":"…","newSha":"…","reason":"hotfix for incident 42"}
```

`user` comes from `git config user.name` / `user.email`. `status` shows the count and the last timestamp; `audit` lists all entries.

---

## 11. Command reference

Global options: `-V, --version` prints the version; `-h, --help` works on every command. Errors are printed as `[vcs-protection] <message>` with exit code 1. All commands except `install --global` / `uninstall --global` and `postinstall` must run inside a git working tree.

### `init`

```
vcs-protection init [-b, --branches <list>] [-a, --approvals <n>] [--github]
```

Sets up protection in the current clone.

1. Checks git ≥ 2.28.
2. If no rules exist (neither on the remote default branch nor in the working tree), creates `.vcs-protection.json`:
   - branches from `--branches` (comma-separated, globs allowed), or a prompt whose default is the remote default branch (else the current branch, else `main`);
   - approvals from `--approvals`, or a prompt defaulting to `1`.
   Without a TTY (scripts, CI), prompts silently take their defaults.
3. If rules exist, reuses them (`✔ Using rules from …`); no prompts.
4. Installs the hooks with the rules' `failMode`, chaining existing hooks.
5. With `--github`, writes the guard workflow; otherwise prints a tip if it is missing.
6. If it created files, prints how to commit them through a PR (and the bypass bootstrap for empty remotes), and how teammates get the hooks.

Safe to re-run: it refreshes the hooks and never overwrites an existing config.

### `protect <pattern>`

```
vcs-protection protect <pattern> [-a, --approvals <n>] [--allow-deletion] [--no-commit] [--no-push]
```

Adds or updates a rule in the **working-tree** config (it requires `.vcs-protection.json` to exist locally).

- New rule: `requiredApprovals` = `--approvals` or `1`; `allowDeletion` = `--allow-deletion` or `false`. Existing rule: unspecified options keep their current values. The rule moves to the end of the list.
- Regenerates the guard workflow (if present) so its branch filter includes the pattern.
- Shares the change through a PR:
  - if the current branch is detached, protected by the effective rules, or the default branch, a new branch `vcs-protection/rules-<yyyymmddhhmmss>` is created;
  - commits only `.vcs-protection.json` and the workflow, as `chore(vcs-protection): protect <pattern>`;
  - pushes to `remote` and opens a PR into the default branch when a token is available (otherwise prints a compare link).
- `--no-commit`: only edit the files. `--no-push`: commit but don't push or open a PR.
- `--approvals` must be an integer ≥ 0 (`Invalid --approvals: …`).

### `unprotect <pattern>`

```
vcs-protection unprotect <pattern> [--no-commit] [--no-push]
```

Removes the rule with exactly this pattern, then shares the change like `protect`. The branch **stays protected for everyone until the PR is merged** (and the guard judges that merge by the old rules, so it needs approvals). Errors:

- `'release/1.0' is protected by pattern 'release/*'. Unprotect that pattern instead.`
- `'nope' is not protected.`

### `list`

```
vcs-protection list [--json]
```

Shows the effective rules and where they came from (`remote` or `local`). `--json` prints `{ "source", "location", ...config }`.

### `status`

Shows `list`, then the state of each hook in the hooks directory (with `(chains <hook>.local)` where relevant), then the number of logged local bypasses and the time of the last one.

### `doctor`

```
vcs-protection doctor [--fix]
```

Checks the installation and exits 1 if any check fails:

| Check | Fails when |
|---|---|
| git version | git < 2.28 |
| config | – (shows location and source) |
| config shared | the rules only exist in the working tree, not on the remote default branch |
| core.hooksPath | – (informational) |
| hook `<name>` ×6 | not `installed` |
| GitHub guard | the workflow is missing, or differs from what `github setup` would generate for the current rules and the pinned version |

`--fix` reinstalls `missing` and `outdated` hooks (not `foreign` ones). Other failures stay.

### `github setup`

```
vcs-protection github setup [--pin <version>]
```

Writes `.github/workflows/vcs-protection-guard.yml` for the effective rules. The workflow runs `npx --yes vcs-protection@<version> ci-guard`; the version is `--pin`, or the running CLI's version. Commit the file through a PR. Re-run it after hand-editing the patterns (`protect`/`unprotect` do it for you).

### `audit`

```
vcs-protection audit [--since <date>] [--limit <n>]
```

1. Lists every local bypass from the audit log.
2. With a GitHub remote and a token: for each protected remote-tracking branch (`refs/remotes/<remote>/*`), walks its **first-parent** history (up to `--limit`, default 50, optionally `--since`, in any `git log --since` format) and checks each commit:
   - `✔ <sha7> PR #n (x/y approvals)`: it is associated with a merged PR into this branch that has enough approvals;
   - `✖ <sha7> not from a merged pull request: <subject> (<author>)`;
   - `✖ <sha7> PR #n: <approvals>: <subject>`: merged without enough approvals.
3. Without a token, skips step 2 with a notice.

Exits 1 if it found problems **or** there are logged bypasses; 0 otherwise. Run `git fetch` first so the remote-tracking branches are current.

### `install --global`

```
vcs-protection install --global [--force]
```

Writes the shims to `~/.vcs-protection/git-template/hooks` and sets `init.templateDir` to `~/.vcs-protection/git-template`. Refuses if `init.templateDir` points somewhere else, unless `--force`. Idempotent. Existing clones are not changed. `npm i -g` does the same automatically (without `--force`).

### `uninstall`

```
vcs-protection uninstall [--global]
```

- Without `--global`: removes the managed hooks from this clone and restores `<hook>.local` files. Foreign hooks are untouched.
- With `--global`: unsets `init.templateDir` (only if it points at our template) and deletes `~/.vcs-protection/git-template`. Clones made from it keep their hooks; run `uninstall` in them.

### `hook <name> [args...]` (internal, hidden)

Called by the shims. `<name>` is one of the six hooks (otherwise `Unknown hook '<name>'.`, exit 1). For `reference-transaction` and `pre-push`, reads stdin. Exit 0 lets git continue; 1 blocks. Useful for debugging, for example:

```sh
echo "refs/heads/feature $(git rev-parse feature) refs/heads/main $(git rev-parse origin/main)" \
  | vcs-protection hook pre-push origin <url>
```

### `ci-guard` (internal, hidden)

Run by the guard workflow. Needs `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, `GITHUB_REPOSITORY` and a token. See [section 12](#12-the-github-actions-guard).

### `postinstall` (internal, hidden)

Run by the npm `postinstall` script (through `scripts/postinstall.mjs`). Performs the automatic setup of [section 4](#4-installation-and-automatic-setup). Always exits 0.

---

## 12. The GitHub Actions guard

### 12.1 The workflow

`github setup` (and `init --github`, `protect`, `unprotect`) generate:

```yaml
on:
  push:
    branches: ['main', 'release/*']     # one entry per protected pattern
  delete:
  pull_request:
    types: [opened, synchronize, reopened, edited]
  pull_request_review:
    types: [submitted, edited, dismissed]

permissions:
  contents: write        # create/update/delete refs
  issues: write          # open violation issues
  pull-requests: read    # PRs and reviews
  statuses: write        # the approvals status

concurrency:
  group: vcs-protection-${{ github.event_name }}-${{ github.event.ref || github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  guard:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx --yes vcs-protection@<version> ci-guard
        env: { GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
```

The job needs no checkout: it reads everything through the GitHub API. Runs for the same branch are serialised, never cancelled. The runner sets `CI=true`, so the package's automatic setup does nothing during `npx`. The repository setting **Workflow permissions: Read and write** is required.

### 12.2 Push to a protected branch

The rules are loaded from `.vcs-protection.json` **at the commit before the push** (for a new branch: at the default branch). If there is none, the run ends with `No .vcs-protection.json at <ref>; nothing to enforce.` Otherwise the push is judged:

| Case | Verdict |
|---|---|
| Branch not protected | ok |
| Pusher is in `github.bypassUsers` | ok |
| Branch deleted, rule allows deletion | ok |
| Branch deleted | violation `deleted` |
| Branch created, and it is the default branch (first push) | ok |
| Branch created, and its commit is already in the default branch (`behind` or `identical` in a compare) | ok |
| Branch created from other commits | violation `created` |
| Force push | violation `force-push` |
| New head is **not** the merge commit of a merged PR into this branch | violation `direct-push` |
| It is, but the PR lacks approvals or has outstanding change requests | violation `insufficient-approvals` |
| It is, with enough approvals | ok: `merged from PR #n (x/y approvals)` |

"Merge commit of a PR" means GitHub reports a merged PR into this branch whose `merge_commit_sha` equals the pushed head. That covers merge commits, squash merges and rebase merges done by GitHub.

### 12.3 Counting approvals

For each reviewer, only their **latest decisive** review counts:

- `APPROVED` and `CHANGES_REQUESTED` set the reviewer's standing; `DISMISSED` clears it; `COMMENTED` and `PENDING` don't change it.
- The PR author's own reviews never count.
- If anyone's latest standing is "changes requested", the check fails regardless of the approval count (`Changes requested by <login>`).
- Otherwise it passes when approvals ≥ `requiredApprovals` (`x/y approvals`).

### 12.4 Remediation

For a violation with `enforcement: "revert"`:

| Violation | Action |
|---|---|
| `deleted` | Recreate the branch at the commit before the deletion: `Restored 'x' at <sha7>.` |
| everything else | 1. Save the pushed head on `<rescueBranchPrefix><branch>-<sha7>` (reusing it if it exists). 2. **Compare-and-swap:** if the branch has moved again since this push, leave it alone and say so in the issue (a newer push is never overwritten). 3. Otherwise: for a newly created branch, delete it; for an existing branch, force-reset it to the `before` commit. |

With `enforcement: "report"`, nothing is changed (`Enforcement is "report": nothing was reverted.`).

In both modes an issue is opened, titled `vcs-protection: <kind> on <branch> (<sha7>)`, with who pushed (`@login`), what happened, the rule, the before/after SHAs, the PR link (if any), the actions taken, a compare link to open a PR from the rescue branch, and the command that re-syncs local clones:

```sh
git fetch origin && git switch main && git reset --hard origin/main
```

The step summary shows `❌ <reason>` and the actions, and the job fails (red), so violations are visible in the Actions tab.

### 12.5 Branch deletion events

GitHub sometimes delivers only a `delete` event (with no SHA) for a deleted branch. In that case the guard waits 20 seconds (to let a push-triggered run restore it); if the protected branch is still missing, it opens `vcs-protection: protected branch <x> deleted` with restore instructions (`git push origin origin/<x>:refs/heads/<x>` from any clone that still has it). Allowed deletions and `bypassUsers` are ignored.

### 12.6 Pull request status

On `pull_request` and `pull_request_review` events for a PR into a protected branch, the guard posts a commit status with context **`vcs-protection/approvals`** on the PR's head commit, using the rules at the PR's base commit:

- ✅ `1/1 approvals: OK to merge`
- ❌ `0/1 approvals: merging now will be reverted`
- ❌ `Changes requested by <login>: merging now will be reverted`

The job itself stays green for PR events; the status carries the information. There is no server-side blocking of the merge button: that is exactly the protection GitHub doesn't offer in this situation. The guard reverts a bad merge after the fact.

### 12.7 GitHub Enterprise

The host is taken from `GITHUB_SERVER_URL`; the API base is `https://<host>/api/v3` for hosts other than `github.com`.

---

## 13. GitHub API access

Used by `protect`/`unprotect` (opening PRs), `audit`, and `ci-guard`. The token is looked up in this order:

1. `GITHUB_TOKEN`
2. `GH_TOKEN`
3. `gh auth token` (the GitHub CLI's stored login)

The repository comes from the configured remote's URL. Supported forms: `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo(.git)`, `ssh://git@github.com/owner/repo(.git)`, including GitHub Enterprise hosts (any host whose name contains `github`). Without a token or a GitHub remote, `protect`/`unprotect` print a compare link instead of opening the PR, and `audit` skips the remote part.

---

## 14. Environment variables

| Variable | Used by | Effect |
|---|---|---|
| `VCS_PROTECTION_BYPASS` | hooks | Non-blank reason: let the blocked operation through (if `bypass.allowed`) and log it. |
| `VCS_PROTECTION_SKIP_INSTALL` | automatic setup | Any value other than empty, `0`, `false`: skip the setup during `npm install`. |
| `CI` | automatic setup | Any value other than empty, `0`, `false`: skip the setup. |
| `INIT_CWD` | automatic setup | Set by npm: where `npm install` was run. Determines the target repository. |
| `npm_config_global`, `npm_config_location` | automatic setup | Set by npm: `true` / `global` selects global mode. |
| `VCS_PROTECTION_CLI_PATH` | hook installation | Overrides the CLI path embedded in shims (useful for packaging or tests). |
| `GITHUB_TOKEN`, `GH_TOKEN` | `protect`, `unprotect`, `audit`, `ci-guard` | GitHub API token. |
| `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, `GITHUB_REPOSITORY` | `ci-guard` | Provided by GitHub Actions; required. |
| `GITHUB_SERVER_URL` | `ci-guard` | GitHub host (Enterprise). Default `https://github.com`. |
| `GITHUB_STEP_SUMMARY` | `ci-guard` | If set, results are also written to the job summary. |
| `NO_COLOR` | all | Disables colours. |
| `FORCE_COLOR` | all | Enables colours even when stderr isn't a TTY. |

---

## 15. Files and locations

| Path | Committed? | Purpose |
|---|---|---|
| `.vcs-protection.json` | yes | The rules. |
| `.github/workflows/vcs-protection-guard.yml` | yes | The GitHub guard. |
| `package.json` → `devDependencies`, `allowScripts` | yes | Automatic setup on `npm install` (Node.js projects). |
| `.git/hooks/<hook>` (or `core.hooksPath`) | no | The six shims. |
| `.git/hooks/<hook>.local` | no | Chained pre-existing hooks. |
| `.git/vcs-protection/audit.log` | no | Local bypass log (in the git common dir). |
| `~/.vcs-protection/git-template/hooks/` | – | Global template (`install --global` / `npm i -g`). |
| `~/.gitconfig` → `init.templateDir` | – | Points git at the template. |

---

## 16. Exit codes

| Command | 0 | 1 |
|---|---|---|
| any command | success | error (message printed) |
| `hook <name>` | let git continue | block the operation |
| `doctor` | all checks pass | at least one check fails |
| `audit` | no problems and no logged bypasses | problems found, or bypasses logged |
| `ci-guard` (push) | ok, or no rules | violation (after remediation) |
| `ci-guard` (delete) | nothing to report / already restored | issue opened |
| `ci-guard` (PR) | always (the status carries the result) | – |
| `postinstall`, `scripts/postinstall.mjs` | always | – |

---

## 17. Limitations

- **Local hooks can be removed.** `rm .git/hooks/*`, `vcs-protection uninstall`, `npm install --ignore-scripts` and not running the setup all leave a clone unprotected. Self-repair on checkout/merge, `doctor`, the automatic setup on every `npm install`, and the GitHub guard reduce the impact.
- **The workflow runs from the pushed commit.** GitHub runs workflow files from the commit being pushed, so a direct push that also deletes or edits `vcs-protection-guard.yml` isn't checked. `vcs-protection audit` finds such commits afterwards.
- **Merges are reverted, not prevented.** A PR merged without enough approvals shows as "merged" on GitHub and is then reverted. The issue and the rescue branch explain how to redo it properly.
- **Blocked fast-forward merges and `reset --hard` leave files updated.** Git updates the working tree before the ref. The block message prints the `git read-tree -m -u <sha> HEAD` command that restores them.
- **PR association lag.** GitHub may take a few seconds to associate a merge commit with its PR; a legitimate merge could then be judged `direct-push`. Re-running the job fixes it.
- **Uninstalling the package leaves hooks behind.** npm runs no uninstall scripts; see [4.6](#46-removing-the-hooks).
- **npm ≥ 12 needs approval** for the automatic setup ([4.3](#43-npm-12-and-install-script-approval)); other package managers may not run dependency scripts at all (for example pnpm ≥ 10 without `onlyBuiltDependencies`), in which case use `vcs-protection init`.
- **Node start-up cost.** Operations on protected branches, and `pre-commit` on any branch in a protected repository, start Node (about 150–200 ms).

---

## 18. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `npm install` installed no hooks | npm ≥ 12 without approval (`npm install-scripts approve vcs-protection`); `--ignore-scripts`; `CI` or `VCS_PROTECTION_SKIP_INSTALL` set; not a git repository. Re-run with `--foreground-scripts` to see the script's output, or run `npx vcs-protection init`. |
| `status`/`doctor` show all hooks `outdated` | The hooks were installed by a different CLI (for example the project's `node_modules` copy while you run the global one). Use `npx vcs-protection status`, or `doctor --fix` with the CLI you want the hooks to use. |
| `CLI not found: branch protection is NOT active` | The CLI the hooks point at was removed (`npm uninstall`, deleted `node_modules`, moved Node install). Run `npm install` (dependency) or `vcs-protection init` (global) again. |
| `npm i -g` left `init.templateDir` unchanged | Another template was already configured. `vcs-protection install --global --force` replaces it. |
| Hooks don't fire at all | `vcs-protection doctor`. Check `git config core.hooksPath`, that `reference-transaction` exists in the hooks directory, and that git ≥ 2.28. |
| Rules edited locally have no effect | Expected: the copy on `origin/<default>` wins. Merge the change, then `git fetch`. |
| `git pull` on `main` is blocked | Your local `main` has commits that aren't on `origin/main`, so the pull wants to create a merge commit. Move them to a branch, then `git reset --hard origin/main`. |
| A legitimate PR merge was reverted as `direct-push` | GitHub's commit-to-PR association lagged. Re-run the job; report it if it keeps happening. |
| Guard fails with `403 Resource not accessible by integration` | Workflow permissions aren't "Read and write". |
| `protect` doesn't open a PR | No token: `gh auth login` or set `GITHUB_TOKEN`. The printed compare link still works. |
| `doctor`: `GitHub guard … out of date` | The workflow's branch list doesn't match the rules (hand edit), or it was modified. Run `vcs-protection github setup`. |

---

## 19. Architecture and source map

```
src/
├── cli.ts                  commander program: all commands, lazy-loaded
├── version.ts              version from package.json
├── ui.ts                   colours, info/warn/error, blocked-operation box
├── messages.ts             block message texts (section 9)
├── config/
│   ├── schema.ts           zod schema, defaults, parse/serialize (section 5)
│   └── load.ts             effective rules: remote default branch wins (section 6)
├── rules/
│   ├── match.ts            picomatch patterns, first matching rule
│   └── evaluate.ts         pure rule engine: evaluateRefUpdate, evaluatePush (section 7)
├── git/
│   ├── exec.ts             spawnSync wrappers: git, gitMaybe, gitOk, gitRaw
│   └── repo.ts             repo root, hooks dir, refs, ancestry, remote default, in-progress ops
├── hooks/
│   ├── shim.ts             the POSIX shim template (section 8.2)
│   ├── install.ts          install/uninstall/status of shims, chaining (8.3, 8.4)
│   ├── handlers.ts         hook implementations: reference-transaction, pre-push, pre-commit(-like), self-check
│   └── context.ts          bypass env var, stdin reader, GitHub repo of the remote
├── audit/log.ts            JSONL bypass log (section 10)
├── github/
│   ├── remote.ts           parse remote URLs, compare/API URLs
│   ├── client.ts           minimal REST client, token resolution (section 13)
│   ├── guard.ts            judgePush, remediatePush, deletes, PR status, review counting (section 12)
│   └── workflow.ts         workflow template
└── commands/
    ├── init.ts             init
    ├── rules.ts            protect / unprotect and PR sharing
    ├── status.ts           list / status / doctor
    ├── github.ts           github setup / audit
    ├── install.ts          install --global / uninstall
    ├── postinstall.ts      automatic setup run by npm (section 4)
    ├── ciGuard.ts          ci-guard entry point
    └── shared.ts           config/workflow helpers, prompts, GitHub client factory
scripts/postinstall.mjs     npm lifecycle wrapper: guards, then runs `dist/cli.js postinstall`
```

**A blocked commit, end to end:** `git commit --no-verify` on `main` → git prepares the ref transaction → the `reference-transaction` shim (state `prepared`, `refs/heads/main` in the input, config present) → `node dist/cli.js hook reference-transaction prepared` → `runHook` loads the effective rules → `handleReferenceTransaction` parses the updates → `evaluateRefUpdate` returns `block advance` (new commit not on `origin/main`, old commit is its ancestor) → `blockMessage` builds the text → exit 1 → git aborts: `fatal: ref updates aborted by hook`.

**Design notes:**

- The rule engine and the guard's verdict logic take their repository/API access as parameters, so they are unit-tested without git or network.
- The CLI is bundled into **one file** (`dist/cli.js`, tsup with `splitting: false` and all dependencies inlined). Shims embed this file's path, so code must never move into separate chunks, and `npx` in CI installs nothing extra.
- Commands are loaded with dynamic `import()`, so hooks only pay for the code they use.
- The postinstall wrapper is plain JavaScript without dependencies. It runs before anything is guaranteed to be built (in vcs-protection's own checkout) and must not fail. It spawns the real CLI rather than importing it, so `cliPath()` resolves to `dist/cli.js`, which is the path the shims must embed.

---

## 20. Development and release

### 20.1 Setup and scripts

```sh
npm install          # the postinstall wrapper exits quietly: dist/ doesn't exist yet
npm run build        # tsup → dist/cli.js
npm run typecheck    # tsc --noEmit
npm test             # build, then all tests (vitest)
npm run test:unit    # unit tests only (no build needed)
```

After a build, `npm install` in this repository still doesn't install hooks here: the setup recognises the package's own repository and skips it.

### 20.2 Tests

| Suite | What it covers |
|---|---|
| `test/unit/evaluate.test.ts` | Pattern matching, and the rule engine's allow/block/bypass paths for ref updates and pushes. |
| `test/unit/guard.test.ts` | Review counting, push verdicts (direct push, force push, approvals, deletion, bypass users), remediation (rescue branch, compare-and-swap, report mode) and the PR status, with a fake GitHub client. |
| `test/unit/misc.test.ts` | Remote URL parsing, config parsing and defaults, reference-transaction input parsing, and rendering of the shim, the workflow and block messages. |
| `test/integration/hooks.test.ts` | Real git repositories in a temp dir (bare origin + two clones): commits, `--no-verify`, merges, resets, pushes, bypass, chaining, self-repair. |
| `test/integration/postinstall.test.ts` | The automatic setup: package laid out under `node_modules` of a temp repository; hooks installed and pointing there, `failMode` from the config, chaining, subdirectories, the skip conditions, non-git directories, the package's own repository, missing `dist/`, and global mode (`init.templateDir` set, idempotent, foreign template left alone). |

Integration tests isolate git with `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM` and a temporary `HOME`, and clear `CI`, the npm variables and tokens, so they behave the same locally and in CI.

CI (`.github/workflows/ci.yml`) runs typecheck and tests on Ubuntu, Windows and macOS with Node 22 and 24.

### 20.3 Published contents

`files` in `package.json` limits the tarball to `dist/`, `scripts/` (the postinstall wrapper) and `README.md`, plus `package.json`. Check with `npm pack --dry-run`: 4 files, about 1.1 MB unpacked.

### 20.4 Release

1. Run the end-to-end procedure in [Workflow.md](Workflow.md) against a disposable GitHub repository.
2. Bump the version (`npm version patch|minor|major`). Generated workflows pin this version, so publish before teams regenerate them.
3. `npm publish --dry-run`, then `npm publish` (`prepublishOnly` runs typecheck and the full test suite).
4. Verify on a clean machine: `npm i -g vcs-protection` configures `init.templateDir`; in a Node project, `npm i -D vcs-protection` (+ approval on npm ≥ 12) and a fresh-clone `npm ci` installs the hooks.
