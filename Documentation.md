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
13. [The studio](#13-the-studio)
14. [GitHub API access](#14-github-api-access)
15. [Environment variables](#15-environment-variables)
16. [Files and locations](#16-files-and-locations)
17. [Exit codes](#17-exit-codes)
18. [Limitations](#18-limitations)
19. [Troubleshooting](#19-troubleshooting)
20. [Architecture and source map](#20-architecture-and-source-map)
21. [Development and release](#21-development-and-release)

---

## 1. Overview

`vcs-protection` adds branch protection to git repositories when GitHub's server-side branch protection is not available (for example, private repositories on plans that don't include it). It enforces one policy:

> Changes reach a protected branch only through a pull request with enough approvals.

It does this on two layers:

| Layer | Where it runs | What it does |
|---|---|---|
| **Local git hooks** | Every teammate's clone | Refuse commits, merges, cherry-picks, rebases, resets and pushes that would change a protected branch. This includes `git commit --no-verify`, through the `reference-transaction` hook. |
| **GitHub Actions guard** | On GitHub, on every push to a protected branch, on PR events, every 30 minutes (the sweep), and (optionally) when critical CI workflows finish | Judge every commit on a protected branch that it hasn't verified yet: only commits merged from a PR approved by people with write access are accepted. Otherwise save the commits to a rescue branch, move the branch back atomically (or report, when reviewed work landed on top), and open an issue. Also posts an approvals status on PRs. With the optional **poison pill**, a merge that makes a critical CI workflow fail gets the same treatment. |

The package is a single Node.js CLI (`vcs-protection`). The git hooks are small POSIX shell scripts ("shims") that call the CLI. The GitHub guard is a generated workflow that runs the same CLI with `npx`. `vcs-protection studio` opens a local web UI for everything the commands do (section 13).

---

## 2. Concepts and threat model

- **Protected branch:** a branch whose name matches a `pattern` in the configuration (`main`, `release/*`, …).
- **The remote:** the shared repository (`origin` by default, configurable with `remote`). Protection is defined relative to what is already on the remote.
- **Effective rules:** the rules that currently apply. They are read from the remote's default branch, not from your working tree (see [section 6](#6-how-the-effective-rules-are-found)). Changing the rules therefore requires a reviewed PR as well.
- **Bypass:** a logged, per-command escape hatch (`VCS_PROTECTION_BYPASS="<reason>"`) for emergencies and for the one-time bootstrap.

**What it defends against:** honest mistakes and shortcuts: committing on `main` by accident, `--no-verify`, fast-forward merging locally and pushing, force-pushing, merging a PR in the GitHub UI without approval, deleting a protected branch, and (with the poison pill) approved merges that break the critical test suites.

**What it doesn't defend against:** a determined teammate with write access. Local hooks can be removed, and a determined teammate can, for example, delete the guard workflow and its sweep in the same push, or run their own workflow that posts fake markers (see [Limitations](#18-limitations)). These are guardrails, not a security boundary. The `audit` command exists to detect what slipped through.

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

1. finds the **project**: the directory above the first `node_modules` in the package's own path, and the git repository that contains it. This is derived from where the package is installed, not from `INIT_CWD` (npm's invocation directory), so `npm install --prefix other/project` run from inside another repository still targets the right one. Monorepos with a hoisted `node_modules` work too;
2. checks that the project depends on vcs-protection **directly**: in its `package.json` (`dependencies`, `devDependencies` or `optionalDependencies`) or in one of its workspaces (npm/yarn `workspaces`, or pnpm's `pnpm-workspace.yaml` `packages:` list). A package that merely pulls vcs-protection in as a dependency of its own doesn't install hooks into your repository;
3. reads the effective rules, to take the `failMode` from them (`open` when there are no rules yet, or when they can't be read);
4. installs, or refreshes, the six hook shims in that repository's hooks directory (honouring `core.hooksPath`, see below, and chaining any existing non-vcs-protection hook as `<hook>.local`);
5. prints what it did. If the repository has no `.vcs-protection.json` yet, it adds that the hooks stay inactive until one exists.

**`core.hooksPath` inside the working tree:**

- **Generated and git-ignored** (husky's `.husky/_`): husky rewrites its own hooks on every install, so only **`reference-transaction`** is installed there. That is the hook that does the enforcement, and husky never touches it. For the earlier pre-commit/pre-push messages, call `npx vcs-protection hook pre-push "$@"` (etc.) from your husky scripts.
- **Tracked** (e.g. a shared `.githooks/` folder): nothing is installed automatically, because the shims contain absolute paths of one machine and would show up as changes to commit. Call `npx vcs-protection hook <name> "$@"` from those hooks, or run `npx vcs-protection init` to install them anyway (it warns about the same thing).

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
| The project (4.1) isn't inside a git working tree | Nothing to install into. A note is printed. |
| The package isn't inside a `node_modules` directory | vcs-protection's own repository (developing it), or a linked install (`npm link`, `file:` directories). Run `vcs-protection init` for linked installs. |
| The package is in npm's `npx` cache or a `dlx` cache (a path segment `_npx` or `dlx`) | `npx`/`pnpm dlx vcs-protection@x …` install into a temporary cache; hooks must not point there. |
| The project doesn't list vcs-protection itself (a transitive dependency) | Not the project's decision. |
| `core.hooksPath` is a tracked directory inside the working tree | See 4.1; a warning explains what to do. |
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

The push that introduces `.vcs-protection.json` gives the guard its starting point automatically (12.3). If the rules reach the default branch any other way — the guard workflow is added later than the config, or you upgrade from a version without markers — run **Actions → vcs-protection guard → Run workflow** once with **baseline** ticked.

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
    "bypassUsers": [],
    "dismissStaleApprovals": false,
    "sweep": "*/30 * * * *",
    "guardLogin": "github-actions[bot]",
    "poisonPill": {
      "enabled": true,
      "workflows": ["CI"],
      "checks": [],
      "conclusions": ["failure", "timed_out"]
    }
  },
  "failMode": "open"
}
```

### 5.2 Field reference

| Field | Type | Default | Meaning |
|---|---|---|---|
| `$schema` | string | – | Optional; ignored. Lets editors attach a schema. |
| `version` | `1` | **required** | Format version. Only `1` is accepted. |
| `remote` | string | `"origin"` | The remote that represents the shared repository. Rules are read from its default branch, pushes to it (by name, or by a URL/another remote name pointing at the same repository) are checked, and "already on the remote" means on `refs/remotes/<remote>/<branch>`. |
| `protected` | array of rules | `[]` | Protected branch rules (below). |
| `protected[].pattern` | string, non-empty | **required** | Branch name or glob (see 5.3). |
| `protected[].requiredApprovals` | integer ≥ 0 | `1` | Approvals a PR needs for its merge to be kept by the guard, from people with write access other than the author (12.4). `0` still requires the change to come from a merged PR. |
| `protected[].allowDeletion` | boolean | `false` | Whether the branch may be deleted on the remote (`git push origin :branch`, deleting on GitHub). Deleting the *local* branch is always allowed. |
| `bypass.allowed` | boolean | `true` | Whether `VCS_PROTECTION_BYPASS` works in the local hooks. Has no effect on the GitHub guard. |
| `github.enforcement` | `"revert"` \| `"report"` | `"revert"` | What the guard does on a violation. `revert`: save the commits to a rescue branch, reset/delete/restore the branch, open an issue. `report`: only open the issue. |
| `github.rescueBranchPrefix` | string, a valid start of a git branch name | `"vcs-protection/rescue/"` | Prefix of rescue branches. The full name is `<prefix><branch>-<sha7>`. Rejected: spaces, control characters, `..`, `//`, `@{`, `~^:?*[\`, a leading `-`, `/` or `.`, and path parts starting with `.` or ending in `.lock`. |
| `github.bypassUsers` | string[] | `[]` | GitHub logins whose pushes and deletions the guard accepts without checks (for example release managers or bots). Doesn't apply to the poison pill. |
| `github.dismissStaleApprovals` | boolean | `false` | Only count approvals given on the PR's final head commit (12.4). |
| `github.sweep` | 5-field cron string, or `null` | `"*/30 * * * *"` | Schedule of the guard's sweep over all protected branches (12.3). `null` removes the `schedule` trigger. |
| `github.guardLogin` | string ending in `[bot]` | `"github-actions[bot]"` | The account whose markers the guard trusts: the identity of the workflow's token. Change it only if the guard runs with a GitHub App token. Used by `github setup` only: it is written into the workflow as `VCS_PROTECTION_GUARD_LOGIN`, and the guard never reads it from a commit at run time. |
| `github.poisonPill.enabled` | boolean | `false` | Turn on the post-merge check of [12.9](#129-poison-pill-post-merge-ci-breaches). |
| `github.poisonPill.workflows` | string[] | `[]` | The `name:` of each critical workflow (exactly as in its YAML). **At least one is required when `enabled` is `true`** (`github.poisonPill.workflows: list at least one workflow name when the poison pill is enabled`). |
| `github.poisonPill.checks` | string[] | `[]` | Check-run (job) names that count. Empty: every job of the finished critical workflow. |
| `github.poisonPill.conclusions` | array of `failure`, `timed_out`, `cancelled`, `action_required`, `startup_failure`; at least one | `["failure", "timed_out"]` | Check-run conclusions that count as a breach. |
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

Use `protect` / `unprotect` (they also regenerate the workflow's branch list and open a PR), or edit the file on a branch and open a PR yourself. A change takes effect for everyone only after it is merged into the default branch and fetched. After a hand edit, also run `vcs-protection github setup` so the workflow's `push.branches` filter (and, with the poison pill, its `workflow_run` trigger) matches the new settings; `doctor` reports when they differ.

---

## 6. How the effective rules are found

Every command and hook loads the rules the same way:

1. Read the working-tree `.vcs-protection.json`, if present, only to learn the `remote` name (default `origin`).
2. Find the remote's default branch: `refs/remotes/<remote>/HEAD`, else `refs/remotes/<remote>/main`, else `refs/remotes/<remote>/master`.
3. If that ref has a `.vcs-protection.json`, use it (`source: remote`, location `refs/remotes/origin/main:.vcs-protection.json`).
4. Otherwise, use the working-tree file (`source: local`). This covers the initial setup before the rules are merged, and repositories without a remote.
5. Otherwise there are no rules: hooks do nothing, and commands that need rules ask you to run `init`.

Why the remote copy wins: a teammate who relaxes the rules on a feature branch (or deletes the file) changes nothing, because the hooks keep reading the reviewed copy from `origin/main`. Rules change for everyone only after the PR is merged and fetched.

The GitHub guard goes further on the server: it only uses the configuration in commits **it has verified** for the branch (its own markers, 12.3), and those rules change only through verified commits. A push, a `[skip ci]` commit, or a commit that deletes or breaks the file can't disable the check.

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
| Old value is all zeros **but the branch exists** (a forced update: `git branch -f`, `git update-ref` without an old value) | judged as a move from the branch's real current value (the rows below) |
| Branch is being **created** and the new commit is reachable from the remote default branch | allow (e.g. `git switch main` from a tracking branch, `git branch release/2 origin/main`) |
| Branch is being created from anything else | block `create` |
| Old commit is an ancestor of the new one (new commits on top) | block `advance` |
| Anything else (history moved sideways or backwards) | block `rewrite` |

Refs updated earlier in the same transaction are taken into account (for example `git pull`, where `origin/main` and `main` move together, or `git fetch` + checkout in one go).

**Allowed examples:** `git pull` (fast-forward), `git pull --rebase` with no local commits, `git reset --hard origin/main`, `git switch main`, creating a protected branch from `origin/main`, deleting a local protected branch.

**Blocked examples:** `git commit` and `git commit --no-verify` on `main`, `git merge feature` (fast-forward or not), `git cherry-pick`, `git rebase` onto local-only commits, `git reset --hard feature`, `git branch -f main feature` and `git branch -f release/1 origin/main` (when `release/1` has history not on `origin/release/1`), `git update-ref refs/heads/main <commit>`, `git revert` on `main`, creating `release/9` from unpushed commits.

### 7.2 Pushes (pre-push)

For each ref being pushed:

| Check | Result |
|---|---|
| The push goes to a remote other than `remote`: neither its name, nor its URL (git passes the URL for `git push <url>`), nor another remote name with the same URL | allow |
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

1. **Relevance gate** (pure shell, no Node): the hook continues only if the repository has `.vcs-protection.json` in the working tree, or on `<remote>/HEAD`, `<remote>/main` or `<remote>/master`, where `<remote>` is the configured `remote` at install time (`origin` for the global template, which doesn't know the repository). That keeps the global template cheap in unrelated repositories.
2. For `reference-transaction`, Node is started only in the `prepared` state **and** only if a `refs/heads/` ref is involved, so `git fetch` never pays the Node start-up cost.
3. **Run the CLI:** `"$VCSP_NODE" "$VCSP_CLI" hook <name> <args>`. If either file is gone, it falls back to `vcs-protection` on `PATH`. If there is none, it prints `CLI not found: branch protection is NOT active…` and allows (`open`) or blocks (`closed`).
4. **Read the result:** exit **0** allows. Exit **3** is the CLI's "block" answer: the shim exits 1 and git stops. **Any other exit code is a crash** (a bug, an old Node version on the `PATH` fallback, a broken install): the shim prints `[vcs-protection] the <hook> check failed (exit N); failMode is <mode>.` and follows `failMode`, so `open` never locks people out because of a bug. (Shims from versions before this distinction treat every non-zero exit as a block; they show as `outdated` and are refreshed by the self-repair.)
5. **Chained hook:** if `<hook>.local` exists next to the shim, it runs next, with the same arguments and stdin. Its exit code is passed on.

Stdin is read once and passed to both the CLI and the chained hook. The advisory hooks (`post-checkout`, `post-merge`) never fail because of vcs-protection.

On Windows, paths are written with forward slashes, and Git for Windows runs the shims through its bundled `sh`.

### 8.3 Chaining existing hooks

When a hook file that isn't managed by vcs-protection already exists (husky, lefthook, a hand-written hook…), the installer renames it to `<hook>.local` and writes the shim in its place; the shim then calls it. If both `<hook>` and `<hook>.local` already exist, that hook is left untouched and a warning is printed. `uninstall` removes the shim and renames `<hook>.local` back.

If `core.hooksPath` is set, the hooks go into that directory, and the existing hooks there are chained in the same way. `init`, `doctor` and the automatic setup mention it. When that directory is inside the working tree, the automatic setup is more careful (4.1): only `reference-transaction` in a generated, git-ignored directory such as husky's `.husky/_` (husky rewrites the others), and nothing in a tracked one. `init` installs all six but warns.

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

If the CLI throws while running a hook (for example an invalid config on the remote), it prints `Internal error in <hook> hook: …` and then follows `failMode`: `open` allows the operation, `closed` blocks it. If the CLI can't even get that far (it crashes on start, or exits with an unexpected code), the shim applies `failMode` itself (8.2, step 4).

---

## 9. Block messages

When a hook blocks something, it prints a red box on stderr that explains what happened and what to do instead. The message depends on what was attempted:

| Situation | Title | Guidance |
|---|---|---|
| Commit on a protected branch (`pre-commit`, or `advance` with no source branch) | `Direct commits to protected branch 'main' are not allowed.` | `git switch -c <feature-branch>`; abort hints for cherry-pick / revert / rebase in progress |
| Merge into a protected branch (`pre-merge-commit`, a merge in progress, or `advance` whose commits come from a local branch) | `Merging into protected branch 'main' is not allowed.` | Push the source branch, compare link to open a PR, `git merge --abort` |
| `rewrite` | `Rewriting protected branch 'main' is not allowed.` | `git fetch && git reset --hard origin/main`; `git rebase --abort` |
| `create` | `Creating protected branch 'x' from local-only commits is not allowed.` | Create it from a remote commit, e.g. `git branch x <remote>/HEAD` |
| `push` | `Pushing directly to protected branch 'main' is not allowed.` | `git push -u <remote> HEAD:<feature-branch>` and a PR link |
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
| GitHub guard | the workflow is missing, or differs from what `github setup` would generate now (from the working-tree config, like `setup` itself) for the pinned version (`out of date with the config`) |

`--fix` reinstalls `missing` and `outdated` hooks (not `foreign` ones). Other failures stay.

### `github setup`

```
vcs-protection github setup [--pin <version>]
```

Writes `.github/workflows/vcs-protection-guard.yml` for the rules in the working-tree `.vcs-protection.json` (the version you are about to commit; the effective rules if there is no local file), including the `schedule` trigger of the sweep (unless `github.sweep` is `null`) and the `workflow_run` trigger when the poison pill is enabled. The workflow runs `npx --yes vcs-protection@<version> ci-guard`; the version is `--pin` (it must look like a version, e.g. `1.2.3` or `1.2.3-beta.1`; anything else is refused with `Invalid --pin`), or the running CLI's version. Commit the file through a PR. Re-run it after hand-editing the patterns (`protect`/`unprotect` do it for you).

### `audit`

```
vcs-protection audit [--since <date>] [--limit <n>]
```

1. Lists every local bypass from the audit log.
2. With a GitHub remote and a token: for each protected remote-tracking branch (`refs/remotes/<remote>/*`), walks its **first-parent** history (up to `--limit`, a positive number, default 50, optionally `--since`, in any `git log --since` format) and judges each commit **exactly like the guard's history walk** (12.3, 12.4): merge or squash commit of a PR into this branch, a commit of a rebase-merged PR, approvals only from people with write access, `dismissStaleApprovals`, and each commit judged by the rules of the last verified commit below it:
   - `✔ <sha7> merged from PR #n (x/y approvals)`, or `✔ <sha7> before branch protection was set up`;
   - `✖ <sha7> Commit <sha7> was pushed directly to '<branch>' instead of being merged from a pull request. <subject> (<author>)`;
   - `✖ <sha7> Pull request #n was merged into '<branch>' without the required approvals (<approvals>). <subject> (<author>)`.
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

### `studio`

```
vcs-protection studio [-p, --port <n>] [--no-open]
```

Starts the web UI on `127.0.0.1` (a free port unless `--port` is given), prints its link (`Studio running at http://127.0.0.1:<port>/?t=<token>`) and opens it in the browser unless `--no-open`. Runs until Ctrl+C, then prints `Studio stopped.` and exits 0. Works inside and outside a git repository. `--port` must be 0–65535 (`Invalid --port`); a port in use fails with `Port <n> is already in use…`. See [section 13](#13-the-studio).

### `hook <name> [args...]` (internal, hidden)

Called by the shims. `<name>` is one of the six hooks (otherwise `Unknown hook '<name>'.`, exit 1). For `reference-transaction` and `pre-push`, reads stdin. Exit **0** lets git continue; exit **3** blocks; anything else is treated by the shim as a crash (8.2). Useful for debugging, for example:

```sh
echo "refs/heads/feature $(git rev-parse feature) refs/heads/main $(git rev-parse origin/main)" \
  | vcs-protection hook pre-push origin <url>
```

### `ci-guard` (internal, hidden)

Run by the guard workflow. Needs `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, `GITHUB_REPOSITORY` and a token. Handles `push`, `delete`, `pull_request`, `pull_request_review`, `workflow_run`, `schedule` and `workflow_dispatch` events; others are ignored. See [section 12](#12-the-github-actions-guard).

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
  workflow_run:                          # only with the poison pill (12.9)
    workflows: ['CI']
    types: [completed]
    branches: ['main', 'release/*']
  schedule:                              # the sweep (12.3); omitted when github.sweep is null
    - cron: '*/30 * * * *'
  workflow_dispatch:                     # run the sweep by hand (Actions → Run workflow)
    inputs:
      baseline:                          # tick to mark the current tips as verified (12.3)
        type: boolean
        default: false

permissions:
  contents: write        # create/update/delete refs
  issues: write          # open violation issues
  pull-requests: read    # PRs and reviews
  statuses: write        # the approvals status and the markers
  checks: read           # only with the poison pill: check-run results
  actions: read          # only with the poison pill: workflow runs

concurrency:
  group: vcs-protection-${{ (github.event_name == 'workflow_run' && format('pill-{0}', github.run_id)) || ((github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && 'sweep') || (github.event.pull_request.number && format('pr-{0}', github.event.pull_request.number)) || (github.event_name == 'delete' && format('branch-{0}', github.event.ref)) || format('branch-{0}', github.ref_name) }}
  cancel-in-progress: false

jobs:
  guard:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx --yes vcs-protection@<version> ci-guard
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          VCS_PROTECTION_GUARD_LOGIN: 'github-actions[bot]'   # from github.guardLogin
```

The job needs no checkout: it reads everything through the GitHub API. The runner sets `CI=true`, so the package's automatic setup does nothing during `npx`. The repository setting **Workflow permissions: Read and write** is required. On GitHub Enterprise Cloud with data residency (`*.ghe.com`) and on GHES, the guard uses the runner's `GITHUB_API_URL` and `GITHUB_GRAPHQL_URL`.

**Concurrency groups:**

| Runs | Group | Effect |
|---|---|---|
| `push` and `delete` of branch *b* | `branch-<b>` | Runs for the same branch wait for each other. |
| Poison pill (`workflow_run`) | `pill-<run id>` | Every run is on its own: never queued behind another, never cancelled. |
| `schedule`, `workflow_dispatch` | `sweep` | One sweep at a time. |
| Pull request events | `pr-<number>` | Status updates for one PR in order. |

GitHub keeps only **one pending** run per group; a newer queued run cancels the older queued one. The guard doesn't rely on every push run happening: each run judges the branch's whole unverified history (12.3), so a cancelled run's commits are judged by the next one. A sweep can overlap a push run on the same branch; resets are atomic (12.5) and the issue step re-reads the markers first, so this doesn't lose or duplicate anything.

Workflows generated by older versions don't have these triggers, inputs and groups; `doctor` reports them as out of date until `github setup` is re-run.

### 12.2 Push to a protected branch

The rules come from the **newest commit the guard has verified for this branch**, found by walking first parents from `before` (for a new branch: the default branch's newest verified commit). They never come from the pushed commits or from an unverified `before`, so a push can't switch its own check off. Without such a commit, the run goes straight to the walk (12.3), which either recognises the push that introduces the rules or reports that the branch has to be baselined.

First the event itself is judged (`judgePush`):

| Case | Verdict |
|---|---|
| Branch not protected (by the trusted rules) | ok |
| Pusher is in `github.bypassUsers` and the push deletes, creates or force-pushes the branch | ok |
| Branch deleted, rule allows deletion | ok |
| Branch deleted | violation `deleted` → recreated at `before` |
| Branch created, and it is the default branch (first push) | ok → the walk (the bootstrap, 12.3) |
| Branch created at a commit the guard had verified for this branch (a restore, 12.6) | ok, marked |
| Branch created, and its commit is already in the default branch (`behind` or `identical` in a compare) | ok, **marked** as verified for the new branch, so later walks have a starting point |
| Branch created from other commits | violation `created` → deleted |
| Force push | violation `force-push` → reset to `before` |
| Anything else (a regular push) | the history walk (12.3) |

### 12.3 The history walk and the markers

Every push run and every sweep judges the branch **from its current tip back to the newest commit the guard verified for this branch**:

1. **Walk** first parents from the current tip, and stop only at a commit carrying this branch's **accepted marker** (the *anchor*), or at the root commit, or after 100 commits. A missing or broken `.vcs-protection.json` in a commit does **not** stop the walk.
2. **Rules:** start with the config in the anchor. Judge the unverified commits oldest-first; only a commit that is itself verified can change the rules for the commits above it. An unreviewed commit that deletes the config, makes it invalid, or removes the branch from `protected` therefore changes nothing: it is judged by the old rules, and so is everything on top of it. (A reviewed PR that removes protection is legitimate and does take effect.)
3. **Judge** each unverified commit. It is verified if it is:
   - the merge commit or squash commit of a merged PR into this branch with enough approvals (12.4);
   - a commit of a **rebase-merged** PR with enough approvals (GitHub associates the commit with the PR, and the PR's last commit is further up the chain);
   - brought in by a push of a `github.bypassUsers` login. The pusher comes from GitHub's repository activity log (`GET /activity?activity_type=push` / `force_push`), plus the current push event; so a release bot's `[skip ci]` push is recognised by the sweep too.
   Anything else is a violation: `direct-push`, or `insufficient-approvals`. For a commit made in the GitHub UI (committer `web-flow`) that GitHub hasn't linked to its PR yet, the guard retries the lookup after 2, 5 and 10 seconds before deciding.
4. **Decide** (`planRemediation`):
   - If **every** commit from the oldest violation up to the tip is a violation, reset the branch to the first parent of the oldest violation (12.5). This covers one direct push, several quick direct pushes, and pushes whose run never happened.
   - If a verified commit landed on top of a violation (for example a reviewed PR merged after a `[skip ci]` push), nothing is reset: throwing away reviewed work would be worse. The issue lists the violations with the exact `git revert` commands to undo them through a PR.
   - `enforcement: "report"` never resets.
5. **Report, then mark:** re-read the violations' markers (another run may have reported them meanwhile), open the issue for the ones not yet reported, and only **then** mark: verified commits that stay on the branch get the accepted marker; violations that stay get a `failure` marker ("reported: <issue url>"), so later runs don't report them again. If the issue can't be created, nothing is marked and the next run tries again; if Issues are disabled for the repository, the details go to the job log and the markers say `reported in the job log (issues disabled)`.

**The markers** are commit statuses with the context **`vcs-protection/accepted/<branch>`**, visible next to the commit on GitHub. They are per branch: a commit verified on `develop` is not thereby verified on `main`, even after a fast-forward push of `develop` into `main`. Only statuses created by the guard's account count: `github-actions[bot]` by default, the identity of the workflow's `GITHUB_TOKEN`. The account comes from the workflow (`VCS_PROTECTION_GUARD_LOGIN`, rendered from `github.guardLogin` by `github setup`), never from the commits being judged, and it must be a bot account, which a personal token can't post as.

**Starting point (baseline).** A branch without any marker (within 100 commits) has nothing to anchor on:

- **Automatically,** only for the push that **introduces** `.vcs-protection.json` on a branch the guard has never verified (the config is missing at `before` and present at the pushed tip): that tip is marked (`baseline: this push introduced the rules`). This is the normal bootstrap of a new repository (Setup, 4.7).
- **Otherwise** — rules that were committed before the guard existed, an upgrade from a version without markers, a protected branch created while the guard wasn't running, or more than 100 unverified commits — the run is **red** and says `No verified commit on '<branch>' in the last 100 commits: run the guard once with baseline (Actions → vcs-protection guard → Run workflow → baseline).` It accepts nothing and resets nothing. Running the workflow with **baseline** ticked marks the current tip of the default branch and of every branch matching a protected pattern (from the default branch's current config) as verified (`baseline by @<you>`). Only people who can run workflows can do this, and the markers are posted by the bot.

**The sweep** (`schedule`, default every 30 minutes, and `workflow_dispatch` without baseline) first walks the default branch; the rules it ends up trusting decide which other existing branches are protected, and those are walked next. It catches what started no push run at all: a commit message with `[skip ci]` / `[skip actions]` makes GitHub skip every `push` workflow, but not scheduled ones, and scheduled workflows always run from the default branch's copy of the guard. Set `github.sweep` to another cron expression, or to `null` to turn it off.

**Cost:** a run whose tip is already verified makes 3 API calls (branch tip, statuses, config). Each unverified commit costs a few more (status, commit, config, associated PRs, and reviews and permissions for merged PRs), plus two activity-log calls per walk.

### 12.4 Counting approvals

For each reviewer, only their **latest decisive** review counts:

- `APPROVED` and `CHANGES_REQUESTED` set the reviewer's standing; `DISMISSED` clears it; `COMMENTED` and `PENDING` don't change it.
- The PR author's own reviews never count.
- **Only reviewers with write access count** (repository permission `write`, `maintain` or `admin`, looked up with `GET /collaborators/{user}/permission`; non-collaborators get a 404 and don't count). Their change requests are ignored too. This matches GitHub's own branch protection. Permissions are looked up once per reviewer per run.
- With `github.dismissStaleApprovals: true`, only approvals of the PR's final head commit count: pushing a new commit after an approval requires a fresh approval. Change requests stay in force regardless of the commit. Off by default, like on GitHub.
- If any counted reviewer's latest standing is "changes requested", the check fails regardless of the approval count (`Changes requested by <login>`).
- Otherwise it passes when approvals ≥ `requiredApprovals` (`x/y approvals`).

The same rules apply to the PR status (12.7) and to `vcs-protection audit`.

### 12.5 Remediation

The guard never creates revert commits; it moves branches back. Every move is a real **compare-and-swap**: the GraphQL `updateRefs` mutation with `beforeOid` = the tip the guard judged. If anyone pushed or merged in between, GitHub refuses the update, nothing is overwritten, and the next run re-checks. On GitHub Enterprise versions without `updateRefs`, the guard falls back to reading the ref and then updating it (not atomic), and says so in the summary.

| Violation | Action (`enforcement: "revert"`) |
|---|---|
| `deleted` | Recreate the branch at the commit before the deletion: `Restored 'x' at <sha7>.` |
| history walk (`direct-push`, `insufficient-approvals`) | Save the tip on `<rescueBranchPrefix><branch>-<sha7>`, then reset the branch to the commit before the oldest violation (only when every newer commit is a violation, 12.3). |
| `force-push` | Save the pushed tip on a rescue branch, reset to `before`. |
| `created` | Save the pushed commit on a rescue branch, delete the branch. |
| `poison-pill` | See 12.9. |

**Rescue safety:** if the rescue branch can't be created and doesn't already hold exactly the commit being rescued (an invalid name, a name conflict), the guard **doesn't reset** and says so in the issue (`Could NOT save the pushed commits…`). `rescueBranchPrefix` is also validated in the config.

With `enforcement: "report"`, nothing is changed (`Enforcement is "report": nothing was reverted.`).

An issue is opened, titled `vcs-protection: <kind> on <branch> (<sha7>)` (kinds: `direct-push`, `force-push`, `insufficient-approvals`, `created`, `deleted`, `poison-pill`). It lists who pushed (`@login`), the commits and why each is a violation, the rule, the PR link (if any), the actions taken, and either a compare link to open a PR from the rescue branch plus the command that re-syncs local clones:

```sh
git fetch origin && git switch main && git reset --hard origin/main
```

or, when nothing was reset, the `git revert` commands to undo the commits through a PR. The issue is opened **before** any `failure` marker is written (12.3, step 5); with Issues disabled for the repository, the full text goes to the job log instead. The step summary shows one line per judged commit and the actions, and the job fails (red) when something new was found or the branch was reset, so violations are visible in the Actions tab.

### 12.6 Branch deletion events

GitHub sometimes delivers only a `delete` event (with no SHA) for a deleted branch. The guard waits 20 seconds (a push-triggered run may restore it first); if the protected branch is still missing, it looks up the deleted tip in the repository **activity API** (`GET /activity?activity_type=branch_deletion`) and **recreates the branch there**, then opens an issue. If the activity API has no record (or `enforcement` is `report`), it opens `vcs-protection: protected branch <x> deleted` with a restore command that includes the local bypass (the local hooks protect the branch too):

```sh
VCS_PROTECTION_BYPASS="restore <x>" git push origin origin/<x>:refs/heads/<x>
```

A branch restored at a verified commit is accepted by the push check (12.2). Allowed deletions and `bypassUsers` are ignored.

### 12.7 Pull request status

On `pull_request` and `pull_request_review` events for a PR into a protected branch, the guard posts a commit status with context **`vcs-protection/approvals`** on the PR's head commit, using the rules at the PR's base commit and the counting of 12.4:

- ✅ `1/1 approvals: OK to merge`
- ❌ `0/1 approvals: merging now will be reverted`
- ❌ `Changes requested by <login>: merging now will be reverted`

The job itself stays green for PR events; the status carries the information. PRs from forks get a read-only token: the status can't be posted, the run logs that and succeeds. There is no server-side blocking of the merge button: that is exactly the protection GitHub doesn't offer in this situation. The guard reverts a bad merge after the fact.

### 12.8 GitHub Enterprise

The host is taken from `GITHUB_SERVER_URL`; the REST API base is `https://<host>/api/v3` and GraphQL is `https://<host>/api/graphql` for hosts other than `github.com`. Older versions without the `updateRefs` mutation fall back to non-atomic updates (12.5); versions without the activity API fall back to the restore issue (12.6).

### 12.9 Poison pill: post-merge CI breaches

The checks above judge *how* a commit reached a protected branch. The poison pill judges *what it did*: an approved, correctly merged PR that makes a critical CI workflow fail on the protected branch is treated as a breach.

**Enabling it:**

```json
"github": { "poisonPill": { "enabled": true, "workflows": ["CI", "E2E"], "checks": ["unit", "integration"] } }
```

Edit the config on a PR branch, run `vcs-protection github setup` there (it renders the working-tree config, so the workflow gets the `workflow_run` trigger right away), and merge both files in one reviewed PR. The pill only acts on commits merged **after** that PR, because every commit is judged by the rules before it.

**Trigger:** the generated workflow listens to `workflow_run` (`types: [completed]`) for the listed workflows, filtered to the protected branches. The guard wakes up exactly when a critical workflow finishes; it never polls or sleeps, and it can't check "too early". Notes:

- The names in `workflows` must match the critical workflows' `name:` exactly.
- GitHub triggers `workflow_run` only from the workflow file **on the default branch**: the trigger works only after the regenerated guard is merged there, and a pushed commit can't switch the check off by editing the guard.
- Each finished critical workflow triggers one guard run.

**What landed:** the change is the merge that brought the failing commit: one merge commit, one squash commit, or all the commits of a **rebase-merged** PR (found by walking first parents that GitHub associates with the same PR, up to the PR's commit count). "Before" is the commit below all of them.

**Decision** (`evaluatePoisonPill`, pure). The run is ignored (ok) when:

1. the poison pill is disabled in the **trusted** rules before the change (the config in the newest commit the guard verified for the branch, at or below the commit before the change);
2. the workflow run wasn't triggered by a `push` (failing PR builds are not breaches; `ci-guard` exits before any API call);
3. its branch isn't protected, or the workflow isn't in `workflows`;
4. the commit is no longer on the branch (a previous run already reset it), or the poison pill **already reported it**: after each report the guard puts a `vcs-protection/poison-pill` = `failure` status on the commit, so another failing critical workflow, or a re-run of the failed CI, doesn't open a second issue;
5. none of the relevant check runs failed.

The results come from the check-runs API (`GET /commits/{sha}/check-runs`). Relevant check runs are those of the finished workflow run's own check suite, narrowed to `checks` when it isn't empty, that are `completed` with a conclusion in `conclusions`.

Each failing check is then compared with **the same check of the same workflow** on the "before" commit (the workflow's check suites are found with `GET /actions/runs?head_sha=<before>`, so a job with the same name in another workflow doesn't count):

| On the "before" commit | Meaning |
|---|---|
| failed too | **inherited**: an earlier change broke it (e.g. an innocent PR merged on top of a broken one while CI ran) |
| succeeded / skipped | **caused** by this change |
| missing, still running, or cancelled | **unknown** |

- All inherited → ok, nothing happens (`… already failed on <sha7>; not caused by <sha7>`).
- At least one caused → breach, and a reset is allowed.
- Otherwise (only unknown and inherited) → breach **reported without a reset**: the issue explains that the cause isn't certain and gives the revert commands.

`github.bypassUsers` does **not** apply: the breach is about test results, not about who merged.

**Remediation** uses 12.5 with `before` = the commit before the change and `after` = the failing commit:

| Situation | Result |
|---|---|
| Caused, and the failing commit is still the branch tip | Saved on a rescue branch, the branch is **reset atomically** to "before". The issue says to fix the failing checks on a branch made from the rescue branch and open a new PR. |
| Newer commits landed on top (other merges while CI ran) | The atomic update refuses (the tip moved), so innocent later merges are never discarded. The newer commits' own CI failures are recognised as inherited. The issue gives the undo through a PR: `git switch -c vcs-protection/revert-<sha7> origin/<branch>`, then `git revert -m 1 <sha>` (merge commit), `git revert <sha>` (squash merge) or `git revert --no-edit <before>..<sha>` (all commits of a rebase merge), push, and a compare link. |
| Unknown cause, or `enforcement: "report"` | Nothing is changed; the issue contains the same revert instructions. |

The issue (`vcs-protection: poison-pill on <branch> (<sha7>)`) opens with "…broke a critical CI workflow (poison pill)", lists each failing check with its conclusion, link and origin, the workflow run link, and the merged PR. The job summary shows `❌ Critical checks failed on '<branch>' after <sha7> was merged: <checks>.` and the job fails. A passing run ends with `✅ <branch>: critical checks of '<workflow>' passed on <sha7>`.

Resets made by the guard use `GITHUB_TOKEN`, and GitHub doesn't start workflows for them. CI therefore doesn't re-run on the restored tip; it had already run there.

---

## 13. The studio

`vcs-protection studio` is a local web UI for everything in section 11. It is part of the CLI (no extra install, works offline) and it calls the same functions as the commands, so the rules, checks and messages are identical.

### 13.1 Using it

```sh
vcs-protection studio [--port <n>] [--no-open]
```

It prints `✔ Studio running at http://127.0.0.1:<port>/?t=<token>` and opens that link in the default browser (`open` on macOS, `start` on Windows, `xdg-open` on Linux; if that fails, open the link yourself). The page removes the token from the address bar. Press **Ctrl+C** to stop it.

| Section | Shows | Actions (and the CLI equivalent) |
|---|---|---|
| Overview | Rules source (shared or only in this clone), unmerged local changes, hooks n/6, workflow state, bypass count, the `doctor` checks | **Repair hooks** (`doctor --fix`). Without rules: **Initialize** (`init -b … -a … [--github]`) |
| Rules | The rules in force | **Protect** / **Save** (`protect <pattern> -a <n> [--allow-deletion]`), **Remove** (`unprotect <pattern>`, with confirmation). A share selector sets the mode: open a PR (default), commit only (`--no-push`), file only (`--no-commit`) |
| Guard settings | The working-tree config's `github.*`, `bypass.allowed`, `failMode` | **Save settings**: the new `updateSettings` path: merge into `.vcs-protection.json`, validate with the config schema, regenerate the workflow, then share like `protect` (summary `update settings`) |
| Hooks | Each hook's state, chained `*.local`, the hooks directory, husky / tracked-hooks notes | **Install / refresh** (`init` with the existing rules), **Repair** (`doctor --fix`), **Uninstall** (`uninstall`, with confirmation) |
| GitHub guard | Workflow present / pinned / in sync; GitHub remote; whether a token is available | **Write workflow** (`github setup [--pin]`); links to Actions and to **Run workflow** (the baseline runs on GitHub) |
| Audit | Results per branch (✔/✖, commit, reason, subject), the local bypass log | **Run audit** (`audit [--since] [--limit]`) |
| Machine | `init.templateDir` state | **Install** (`install --global [--force]`), **Remove** (`uninstall --global`, with confirmation) |

- **Outside a git repository** only Overview (a notice) and Machine are shown.
- **One action at a time:** a second one gets `Another action is running; wait for it to finish.` (buttons are disabled meanwhile).
- The page refreshes its data after every action and when the browser tab regains focus; there is no polling.
- Rule and settings changes are made in this clone's `.vcs-protection.json` and go through a pull request, exactly as with the commands. Pushing and opening the PR use the same git configuration and token (`GITHUB_TOKEN`, `GH_TOKEN`, `gh auth token`) as the CLI.

### 13.2 How it works

- `src/commands/studio.ts` starts an `node:http` server (`src/studio/server.ts`) on **127.0.0.1**, on the given port or a free one, and waits for SIGINT/SIGTERM.
- The page (`src/studio/page.ts`) is a single HTML document with inlined CSS and plain JavaScript, built into `dist/cli.js`: no asset files, no CDN, no framework. Repository data is inserted as text nodes only.
- **Output capture:** `withCapturedOutput()` in `src/ui.ts` redirects `info`/`warn`/`error`/`blockBox` into a list while an action runs, so every command's messages appear in the UI exactly as in the terminal.
- **Actions** (`src/studio/actions.ts`) map a name to a zod schema for its arguments and to the CLI function it calls. Supporting refactors: `doctorChecks()` returns the doctor checks as data, `auditReport()` returns the audit as data (both used by the commands too), and `updateSettings()` / `shareChange()` in `commands/rules.ts`.
- **State** (`src/studio/state.ts`) is assembled from the same helpers as `list`, `status` and `doctor`.

### 13.3 API

All `/api/*` requests need the header `X-Studio-Token: <token>`.

| Route | Result |
|---|---|
| `GET /?t=<token>` | The app (without the right token: a short "open the link printed in the terminal" page, status 403). |
| `GET /api/state` | `{ version, cwd, repo, global }`. `repo` is null outside a repository; otherwise it holds the root, branch, remote (with the GitHub owner/repo), `rules` (source, location, config; null without rules), `workingConfig`, `unmerged`, `hooks` (dir, hooksPath, work-tree flags, per-hook state), `workflow` (present, pinned, inSync), `bypasses` (count, last) and `tokenAvailable`. |
| `GET /api/doctor` | `{ checks: [{ name, ok, detail, fixable? }] }`. |
| `GET /api/bypasses` | `{ entries: [...] }`, the audit log. |
| `POST /api/actions/<name>` | JSON arguments → `{ ok, exitCode, output: [{ level, text }], error?, result? }` (`result`: e.g. the audit report). Actions: `init`, `installHooks`, `repairHooks`, `uninstallHooks`, `protect`, `unprotect`, `updateSettings`, `githubSetup`, `audit`, `installGlobal`, `uninstallGlobal`. |

Errors: 400 invalid arguments (`issues: [{ path, message }]`), 403 (token, Host or Origin), 404 unknown route or action, 409 another action running, 413 body over 1 MB, 415 not JSON. A command that fails returns 200 with `ok: false`, its `output` and the `error` message, just as the CLI would print it.

### 13.4 Security

The studio can commit, push, open PRs and change git configuration, so it must only obey its own page:

- **Loopback only:** it listens on `127.0.0.1`; other computers can't connect. (Over SSH, forward the port, e.g. `ssh -L 4000:127.0.0.1:4000 host`, and start it with `--port 4000 --no-open`.)
- **Session token:** 24 random bytes, new on every start, required on every API call and compared in constant time. Other local users and other websites don't have it; an old tab stops working after a restart.
- **Host check:** requests whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>` are refused (DNS rebinding).
- **Origin check:** a POST with an `Origin` other than the studio's own is refused (cross-site requests). No CORS headers are ever sent.
- **JSON only**, at most 1 MB, and each action's arguments are validated.
- **Page hardening:** a Content-Security-Policy allowing only the page's own nonce-tagged script and style (`default-src 'none'`, `connect-src 'self'`, `frame-ancestors 'none'`), plus `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.

---

## 14. GitHub API access

Used by `protect`/`unprotect` (opening PRs), `audit`, and `ci-guard`. The token is looked up in this order:

1. `GITHUB_TOKEN`
2. `GH_TOKEN`
3. `gh auth token` (the GitHub CLI's stored login)

The token needs to read pull requests and reviews and, for approvals, the reviewers' repository permissions (`GET /collaborators/{user}/permission`). In Actions, the workflow's `GITHUB_TOKEN` with the permissions of 12.1 is enough.

The repository comes from the configured remote's URL. Supported forms: `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo(.git)`, `ssh://git@github.com/owner/repo(.git)`, including GitHub Enterprise hosts (any host whose name contains `github`). Without a token or a GitHub remote, `protect`/`unprotect` print a compare link instead of opening the PR, and `audit` skips the remote part.

---

## 15. Environment variables

| Variable | Used by | Effect |
|---|---|---|
| `VCS_PROTECTION_BYPASS` | hooks | Non-blank reason: let the blocked operation through (if `bypass.allowed`) and log it. |
| `VCS_PROTECTION_SKIP_INSTALL` | automatic setup | Any value other than empty, `0`, `false`: skip the setup during `npm install`. |
| `CI` | automatic setup | Any value other than empty, `0`, `false`: skip the setup. |
| `INIT_CWD` | – | Set by npm (where `npm install` was run). Not used for choosing the repository any more; see 4.1. |
| `npm_config_global`, `npm_config_location` | automatic setup | Set by npm: `true` / `global` selects global mode. |
| `VCS_PROTECTION_CLI_PATH` | hook installation | Overrides the CLI path embedded in shims (useful for packaging or tests). |
| `GITHUB_TOKEN`, `GH_TOKEN` | `protect`, `unprotect`, `audit`, `ci-guard`, and the same actions in `studio` | GitHub API token. |
| `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, `GITHUB_REPOSITORY` | `ci-guard` | Provided by GitHub Actions; required. |
| `GITHUB_SERVER_URL` | `ci-guard` | GitHub host (Enterprise). Default `https://github.com`. |
| `GITHUB_API_URL`, `GITHUB_GRAPHQL_URL` | `ci-guard` | Set by GitHub Actions: where the REST and GraphQL APIs are (needed for `*.ghe.com`). Derived from the host when unset. |
| `GITHUB_ACTOR` | `ci-guard` | Set by GitHub Actions: named in baseline markers (`baseline by @<actor>`). |
| `VCS_PROTECTION_GUARD_LOGIN` | `ci-guard` | Set by the generated workflow: the account whose markers count. Default `github-actions[bot]`. |
| `GITHUB_STEP_SUMMARY` | `ci-guard` | If set, results are also written to the job summary. |
| `NO_COLOR` | all | Disables colours. |
| `FORCE_COLOR` | all | Enables colours even when stderr isn't a TTY. |

---

## 16. Files and locations

| Path | Committed? | Purpose |
|---|---|---|
| `.vcs-protection.json` | yes | The rules. |
| `.github/workflows/vcs-protection-guard.yml` | yes | The GitHub guard. |
| `package.json` → `devDependencies`, `allowScripts` | yes | Automatic setup on `npm install` (Node.js projects). |
| `.git/hooks/<hook>` (or `core.hooksPath`) | no | The six shims. |
| `.git/hooks/<hook>.local` | no | Chained pre-existing hooks. |
| `.git/vcs-protection/audit.log` | no | Local bypass log (in the git common dir). |
| Commit statuses `vcs-protection/accepted/<branch>` (on GitHub) | – | The guard's markers: `success` = verified for that branch, `failure` = reported (12.3). |
| Commit status `vcs-protection/poison-pill` (on GitHub) | – | The poison pill already reported this commit (12.9). |
| Branches `vcs-protection/rescue/*` (on GitHub) | – | Rescued commits (12.5). |
| `~/.vcs-protection/git-template/hooks/` | – | Global template (`install --global` / `npm i -g`). |
| `~/.gitconfig` → `init.templateDir` | – | Points git at the template. |

---

## 17. Exit codes

| Command | 0 | 1 |
|---|---|---|
| any command | success | error (message printed) |
| `hook <name>` | let git continue | internal error or unknown hook (the shim applies `failMode`); **3** = block the operation |
| `doctor` | all checks pass | at least one check fails |
| `audit` | no problems and no logged bypasses | problems found, or bypasses logged |
| `ci-guard` (push) | ok, or only already-reported violations | a new violation, a reset, or an uninitialised branch (needs a baseline) |
| `ci-guard` (schedule, workflow_dispatch) | nothing new on any protected branch; always 0 with `baseline` | a new violation, a reset, or an uninitialised branch |
| `ci-guard` (delete) | nothing to report / already restored | issue opened |
| `ci-guard` (workflow_run) | ignored, already reported, or critical checks passed | poison pill detonated (after remediation), or the branch has no verified commit |
| `ci-guard` (PR) | always (the status carries the result) | – |
| `postinstall`, `scripts/postinstall.mjs` | always | – |
| `studio` | stopped with Ctrl+C (SIGINT/SIGTERM) | invalid `--port`, or the port is in use |

---

## 18. Limitations

- **Local hooks can be removed.** `rm .git/hooks/*`, `vcs-protection uninstall`, `npm install --ignore-scripts` and not running the setup all leave a clone unprotected. Self-repair on checkout/merge, `doctor`, the automatic setup on every `npm install`, and the GitHub guard reduce the impact.
- **Push runs use the pushed commit's workflow file.** A direct push that also deletes or edits `vcs-protection-guard.yml` isn't checked by its own push run. The sweep runs from the default branch's copy and catches the commits on its next run (up to `github.sweep` later) — unless the same push also removed the workflow from the default branch. `vcs-protection audit` finds such commits afterwards.
- **`[skip ci]` delays the check.** A commit message with `[skip ci]` makes GitHub skip every `push` workflow. The next push run or the sweep (every 30 minutes by default) judges it; with `github.sweep: null` only the next push does.
- **Markers can be forged by a workflow.** The accepted marker trusts statuses created by `github-actions[bot]`. Personal tokens can't post as that account, but a workflow added on a branch can (its `GITHUB_TOKEN` posts as `github-actions[bot]`). This is deliberate sabotage, not a mistake, and `audit` (which ignores markers) still reports the commits.
- **Reviewed work on top of a violation is kept.** If a reviewed PR is merged after an unreviewed commit, the guard reports the unreviewed commit with `git revert` instructions instead of discarding the reviewed work.
- **A starting point is needed.** The guard only acts on branches with a verified commit. The push that introduces the rules sets it automatically; anything else (existing repositories, upgrades from versions without markers, branches the guard never saw, more than 100 unverified commits) needs one **Run workflow → baseline**, and runs stay red until then. The baseline trusts the current tips, so check them first (`vcs-protection audit` covers older history).
- **Workflow edits.** The guard's account comes from the workflow file. Someone who can push a changed workflow can change it — the same as deleting the guard (above).
- **An old CLI on `PATH`.** When a hook's own CLI is gone, the shim falls back to a `vcs-protection` on `PATH`. A version from before the exit-code change blocks with exit 1, which the new shim treats as a crash and handles by `failMode`.
- **Force pushes that skip the push run.** Removed commits are only detected by the push run of that force push (the sweep only sees what is on the branch now).
- **Merges are reverted, not prevented.** A PR merged without enough approvals shows as "merged" on GitHub and is then reverted. The issue and the rescue branch explain how to redo it properly.
- **Blocked fast-forward merges and `reset --hard` leave files updated.** Git updates the working tree before the ref. The block message prints the `git read-tree -m -u <sha> HEAD` command that restores them.
- **The poison pill reacts after the fact.** It can reset only while the broken change is still the tip, and only when the same checks passed before the change; otherwise it opens an issue with the `git revert` command. A flaky critical test causes a real reset, so keep `workflows`/`checks` to reliable suites.
- **PR association lag.** GitHub may take a few seconds to associate a merge commit with its PR. The guard waits up to about 17 seconds for merges made in the GitHub UI (committer `web-flow`) before deciding; a merge still not linked after that is judged `direct-push` and reset (it's on the rescue branch; re-open or re-merge the PR).
- **Uninstalling the package leaves hooks behind.** npm runs no uninstall scripts; see [4.6](#46-removing-the-hooks).
- **npm ≥ 12 needs approval** for the automatic setup ([4.3](#43-npm-12-and-install-script-approval)); other package managers may not run dependency scripts at all (for example pnpm ≥ 10 without `onlyBuiltDependencies`), in which case use `vcs-protection init`.
- **Node start-up cost.** Operations on protected branches, and `pre-commit` on any branch in a protected repository, start Node (about 150–200 ms).

---

## 19. Troubleshooting

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
| A merge is reported as `insufficient-approvals` although it was approved | The approver has no write access (read/triage roles and outside users don't count), or `dismissStaleApprovals` is on and the approval was given before the last commit. |
| The guard found a violation but didn't reset | Reviewed commits landed on top (the issue has the `git revert` steps), `enforcement` is `report`, the rescue branch couldn't be saved (`Could NOT save…`), or the branch moved during the run (the next run re-checks). |
| Every commit shows a `vcs-protection/accepted/<branch>` status | Expected: that is the guard's marker of verified commits (12.3). |
| Guard runs are red with `No verified commit on '<branch>' … run the guard once with baseline` | The branch has no starting point: existing repository, upgrade from an older version, a protected branch the guard never saw, or more than 100 unverified commits. Check the branch, then Actions → vcs-protection guard → Run workflow → tick **baseline**. |
| `studio`: `Port <n> is already in use` | Another program (or another studio) uses it. Omit `--port` to get a free one. |
| `studio`: the browser doesn't open | No default browser, or a headless/SSH session. Open the printed link yourself; over SSH forward the port (`ssh -L <port>:127.0.0.1:<port>`) and use `--port <port> --no-open`. |
| `studio`: "This studio link is not valid" / API calls fail with 403 | The tab is from an earlier start (a new token is printed every time), or the link was edited. Open the link printed by the running studio. |
| `studio`: "Lost contact with the studio" | The studio was stopped (Ctrl+C) or crashed. Start it again and open the new link. |
| `studio`: "Another action is running" | Actions run one at a time; wait for the current one (for example a long audit) to finish. |
| `Could not open an issue (issues are disabled)` | Issues are turned off for the repository. The details are in the job log; enable Issues to get them as issues. |
| Guard fails with `403 Resource not accessible by integration` | Workflow permissions aren't "Read and write". |
| `protect` doesn't open a PR | No token: `gh auth login` or set `GITHUB_TOKEN`. The printed compare link still works. |
| Poison pill never fires | The guard with the `workflow_run` trigger isn't merged on the default branch yet; `workflows` doesn't match the critical workflow's `name:` exactly; the failing run came from a PR, not a push; or the failing conclusion isn't in `conclusions` (e.g. `cancelled`). The guard run's log explains its decision (`Poison pill: ignoring … : <reason>`, or `✅ … critical checks … passed`). |
| Poison pill opened an issue but didn't reset | Newer commits landed on top of the broken one, or the same checks were unfinished, cancelled or missing before the change (cause unknown). Use the `git revert` command from the issue, through a PR. |
| `doctor`: `GitHub guard … out of date with the config` | The workflow doesn't match the rules (hand edit, a new `sweep`/poison-pill setting, or a workflow generated by an older version without the sweep), or it was modified. Run `vcs-protection github setup`. |

---

## 20. Architecture and source map

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
│   ├── client.ts           minimal REST/GraphQL client: atomic ref update, permissions, statuses, activity (section 14)
│   ├── approvals.ts        pure review counting: latest state, write access, stale approvals (12.4)
│   ├── walk.ts             pure history walk: judgeChain (rules, rebase members, bypass pushes), finalRules, planRemediation (12.3)
│   ├── guard.ts            per-branch markers, trusted rules (trustedConfigFor), event checks, the walk's I/O (guardBranch), baselines, remediation, deletion restore, PR status, poison pill (section 12)
│   └── workflow.ts         workflow template
└── commands/
    ├── init.ts             init
    ├── rules.ts            protect / unprotect and PR sharing
    ├── status.ts           list / status / doctor
    ├── github.ts           github setup / audit
    ├── install.ts          install --global / uninstall
    ├── postinstall.ts      automatic setup run by npm (section 4)
    ├── ciGuard.ts          ci-guard entry point
    ├── studio.ts           studio command: start the server, open the browser, stop on Ctrl+C
    └── shared.ts           config/workflow helpers, prompts, GitHub client factory
├── studio/
│   ├── server.ts           node:http server: token/Host/Origin checks, API routes, one action at a time (section 13)
│   ├── actions.ts          action table: zod schema + the CLI function each action calls
│   ├── state.ts            /api/state, assembled from the same helpers as list/status/doctor
│   └── page.ts             the single-page UI (inlined CSS + vanilla JS, nonce'd for the CSP)
scripts/postinstall.mjs     npm lifecycle wrapper: guards, then runs `dist/cli.js postinstall`
```

**A blocked commit, end to end:** `git commit --no-verify` on `main` → git prepares the ref transaction → the `reference-transaction` shim (state `prepared`, `refs/heads/main` in the input, config present) → `node dist/cli.js hook reference-transaction prepared` → `runHook` loads the effective rules → `handleReferenceTransaction` parses the updates → `evaluateRefUpdate` returns `block advance` (new commit not on `origin/main`, old commit is its ancestor) → `blockMessage` builds the text → the CLI exits 3 → the shim exits 1 → git aborts: `fatal: ref updates aborted by hook`.

**Design notes:**

- The rule engine and the guard's verdict logic take their repository/API access as parameters, so they are unit-tested without git or network. The history walk is split the same way: `guardBranch` fetches commits, configs, markers, PRs, reviews and permissions, and the pure `judgeChain` / `planRemediation` decide. `audit` feeds `judgeChain` from local git history, so it judges exactly like the guard. The poison pill follows the same split: `evaluatePoisonPill(run, config, facts)` is pure, and `judgeWorkflowRun` only gathers the facts (check runs of the commit and of its parent, branch tip, compare, landed range) and builds the push for `remediatePush`.
- The CLI is bundled into **one file** (`dist/cli.js`, tsup with `splitting: false` and all dependencies inlined). Shims embed this file's path, so code must never move into separate chunks, and `npx` in CI installs nothing extra.
- Commands are loaded with dynamic `import()`, so hooks only pay for the code they use.
- The studio adds no dependencies: `node:http`, the existing zod schemas, and a page embedded as a string. It reuses the command functions under `withCapturedOutput()` (`src/ui.ts`) rather than duplicating their logic; `doctorChecks()` and `auditReport()` expose data that both the printing commands and the studio use.
- The postinstall wrapper is plain JavaScript without dependencies. It runs before anything is guaranteed to be built (in vcs-protection's own checkout) and must not fail. It spawns the real CLI rather than importing it, so `cliPath()` resolves to `dist/cli.js`, which is the path the shims must embed.

---

## 21. Development and release

### 20.1 Setup and scripts

```sh
npm install          # the postinstall wrapper exits quietly: dist/ doesn't exist yet
npm run build        # tsup → dist/cli.js
npm run typecheck    # tsc --noEmit
npm test             # build, then all tests (vitest)
npm run test:unit    # unit tests only (no build needed)
```

After a build, `npm install` in this repository still doesn't install hooks here: the package isn't inside a `node_modules` directory, so the setup skips it.

### 20.2 Tests

| Suite | What it covers |
|---|---|
| `test/unit/evaluate.test.ts` | Pattern matching, and the rule engine's allow/block/bypass paths for ref updates (including forced updates with a zero old value) and pushes. |
| `test/unit/walk.test.ts` | The pure core: review counting (latest state, write access, stale approvals), `judgeChain` (merge/squash/rebase-merged PRs, bypass pushes from the activity log, the bootstrap commit, rules that an unverified commit can't relax or delete), `finalRules`, and `planRemediation` (reset only when the whole tail is bad, report otherwise, report mode, already-reported violations). |
| `test/unit/guard.test.ts` | With a fake GitHub API: event checks, remediation (GraphQL compare-and-swap payload, refused swap, fallback without `updateRefs`, rescue failure blocks the reset, report mode), `guardBranch` (two quick pushes both reset, reviewed merge on top gives a report with revert steps, read-only approvers ignored and permissions cached, stop at the marker, forged markers ignored, no duplicate issues), deletion restore through the activity API and its fallback, the PR status, the poison pill (ignore cases, inherited/caused/unknown, same-workflow matching, rebase-merge landed range, revert instructions), and `ci-guard` wiring with a stubbed `fetch` (`workflow_run` from a PR makes no API call, push runs the walk, the sweep, fork PRs). Round-3 cases: a direct push deleting the config (C1) and re-adding a relaxed one, a sweep over a commit that unprotects `main` (C2), per-branch markers (M2), uninitialised branches instead of automatic baselines (H1, M1), the bootstrap push, bypass pushes found in the activity log (H2), issue-before-marker and Issues disabled (M3), a violation reported by another run meanwhile (M6), the PR-link retry (M5), poison-pill dedupe (M4), `updateRefAtomic` error classification, the explicit baseline, markers for new branches, and 403s from forks vs. the same repository. |
| `test/unit/misc.test.ts` | Remote URL parsing, config parsing and defaults (including poison-pill validation), reference-transaction input parsing, and rendering of the shim, the workflow (with and without the `workflow_run` trigger) and block messages. |
| `test/integration/hooks.test.ts` | Real git repositories in a temp dir (bare origin + clones): commits, `--no-verify`, merges, resets, `git branch -f` / `update-ref`, pushes by remote name and by URL, bypass, chaining, self-repair, and crashes following `failMode`. |
| `test/unit/studio.test.ts` | Output capture (restored after a throw), the page (token only inside the nonce'd script, no inline handlers), and one-action-at-a-time (409). |
| `test/integration/studio.test.ts` | The built CLI's `studio --no-open` against a temp repository over raw HTTP: token, Host and Origin checks, 415/413/404, no CORS; state of a repository without rules; `init`, `protect` (file only) with the CLI's messages; settings validated by the schema and the workflow regenerated; `repairHooks` after deleting a hook; the global template; outside a repository; Ctrl+C exits 0; invalid `--port`. |
| `test/integration/postinstall.test.ts` | The automatic setup: package laid out under `node_modules` of a temp repository; hooks installed and pointing there, `failMode` from the config, chaining, subdirectories, `--prefix` from another repository, transitive vs. direct and npm/yarn/pnpm workspace dependencies, the npx and dlx caches, husky-style and tracked `core.hooksPath`, the skip conditions, non-git directories, the package's own repository, missing `dist/`, and global mode (`init.templateDir` set, idempotent, foreign template left alone). |

Integration tests isolate git with `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM` and a temporary `HOME`, and clear `CI`, the npm variables and tokens, so they behave the same locally and in CI.

CI (`.github/workflows/ci.yml`) runs typecheck and tests on Ubuntu, Windows and macOS with Node 22 and 24.

### 20.3 Published contents

`files` in `package.json` limits the tarball to `dist/`, `scripts/` (the postinstall wrapper) and `README.md`, plus `package.json`. Check with `npm pack --dry-run`: 4 files, about 1.2 MB unpacked (the studio page is part of `dist/cli.js`).

### 20.4 Release

1. Run the end-to-end procedure in [Workflow.md](Workflow.md) against a disposable GitHub repository.
2. Bump the version (`npm version patch|minor|major`). Generated workflows pin this version, so publish before teams regenerate them. Mention in the release notes when the generated workflow changes (as with the sweep and the per-branch markers): existing repositories must re-run `vcs-protection github setup`, merge it, and then **Run workflow → baseline** once (markers from older versions don't count any more); existing hooks refresh themselves on the next checkout.
3. `npm publish --dry-run`, then `npm publish` (`prepublishOnly` runs typecheck and the full test suite).
4. Verify on a clean machine: `npm i -g vcs-protection` configures `init.templateDir`; in a Node project, `npm i -D vcs-protection` (+ approval on npm ≥ 12) and a fresh-clone `npm ci` installs the hooks.
