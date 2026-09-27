# vcs-protection

Branch protection for git repositories when GitHub's own branch protection isn't available (for example, private repositories on plans without it).

It works on two layers:

| Layer | What it does | Can it be bypassed? |
|---|---|---|
| **Local git hooks** (every teammate's clone) | Blocks commits, merges, resets, rebases and pushes that would change a protected branch, and **`git commit --no-verify` too** | By uninstalling the hooks, using the logged emergency bypass, or `git push --no-verify` (which skips the push check; the GitHub guard then reverts the push) |
| **GitHub Actions guard** (on the remote) | Checks every push to a protected branch, plus a sweep every 30 minutes. Anything that isn't the merge of a PR approved by people with write access is **reverted**: the commits are saved to a rescue branch and an issue is opened | Only by deliberately removing the workflow from the default branch, or forging its markers (see [Limitations](#limitations)) |

## How `--no-verify` is blocked

`--no-verify` skips the `pre-commit` and `commit-msg` hooks. It does **not** skip git's `reference-transaction` hook (git ≥ 2.28), which runs whenever any ref is about to change. vcs-protection uses that hook to enforce one rule:

> A protected branch may only move to commits that already exist on the remote's copy of that branch.

- **Allowed:** `git pull`, `git pull --rebase`, `git reset --hard origin/main`, checking out a tracking branch. The commits already exist on the remote.
- **Blocked:** `git commit` (with or without `--no-verify`), `git merge` (fast-forward or not), `cherry-pick`, `rebase`, `reset` or `branch -f` to local-only commits, and creating a protected branch from unpushed commits.

The `pre-commit`, `pre-merge-commit` and `pre-push` hooks give earlier, friendlier messages. Each block message explains how to open a pull request instead, with a GitHub compare link.

## Requirements

- git ≥ 2.28 (Git for Windows is supported)
- Node.js ≥ 22.12

## Setup

### Team lead (once per repository)

```sh
npm i -g vcs-protection
cd your-repo
vcs-protection init --branches "main,release/*" --approvals 1 --github
```

This creates `.vcs-protection.json` and `.github/workflows/vcs-protection-guard.yml`, and installs the hooks. Commit both files through a pull request.

For a brand-new repository with nothing on the remote yet, bootstrap once with the bypass:

```sh
VCS_PROTECTION_BYPASS="initial setup" git commit -m "Add branch protection"
VCS_PROTECTION_BYPASS="initial setup" git push
```

On GitHub, check that **Settings → Actions → General → Workflow permissions** is set to **Read and write permissions**. The guard needs it to revert pushes and open issues.

**Starting the guard.** The guard only trusts commits it has verified itself. The push that first adds `.vcs-protection.json` to a branch is taken as the starting point automatically. In every other case — adding the guard to a repository whose rules were committed earlier, upgrading from an older version of vcs-protection, or a protected branch the guard has never seen — run it once by hand: **Actions → vcs-protection guard → Run workflow**, tick **baseline**. That marks the current tip of every protected branch as verified. Until then, guard runs are red with `No verified commit on '<branch>' … run the guard once with baseline`, and accept nothing.

### Every teammate: automatic on `npm install`

The package has a `postinstall` script, so nobody has to run `init` by hand:

- **Node.js projects (recommended):** add it as a dev dependency once and commit `package.json`. Every `npm install` / `npm ci` in a clone then installs, or refreshes, the hooks in that clone.

  ```sh
  npm i -D vcs-protection
  npm install-scripts approve vcs-protection   # npm >= 12 only: allows its postinstall script
  ```

  npm 12 blocks dependency install scripts unless they are listed in the `allowScripts` field of `package.json`; the second command adds the entry. npm 11 runs the script but prints a warning; earlier versions just run it.
- **Global install:** `npm i -g vcs-protection` (npm >= 12: `npm i -g --allow-scripts=vcs-protection vcs-protection`) sets git's global `init.templateDir`, so every future `git clone` on the machine gets the hooks, and prints a notice saying so (undo with `vcs-protection uninstall --global`). Set `VCS_PROTECTION_SKIP_GLOBAL=1` to install the command without touching your git config. If you already have a different `init.templateDir`, it is left alone; run `vcs-protection install --global --force` to replace it. Clones that already exist still need `vcs-protection init`.

The automatic setup never fails `npm install`, never creates a config, and does nothing when:

- `CI` is set (CI runners, including the GitHub guard's `npx` run), or `VCS_PROTECTION_SKIP_INSTALL=1` is set,
- npm runs with `--ignore-scripts`, or the directory is not a git repository.

npm hides the output of dependency install scripts; use `npm install --foreground-scripts` to see it, or check with `vcs-protection status`. `npm uninstall` does not remove the hooks: run `vcs-protection uninstall` first.

Manual setup still works: `vcs-protection init` in a clone, or `vcs-protection install --global` once per machine.

The hooks do nothing in repositories that have no `.vcs-protection.json`.

## Commands

| Command | Description |
|---|---|
| `init [-b <list>] [-a <n>] [--github]` | Create the config (if missing) and install the hooks |
| `protect <pattern> [-a <n>] [--allow-deletion]` | Protect a branch or glob. Commits the change on a PR branch, pushes it, and opens the PR (if a token is available) |
| `unprotect <pattern>` | Stop protecting a pattern. Goes through a PR the same way |
| `list [--json]` | Show the effective rules and where they came from |
| `status` | Rules, hook health, and the number of local bypasses |
| `doctor [--fix]` | Check the installation; `--fix` reinstalls missing or stale hooks |
| `github setup [--pin <version>]` | (Re)generate the Actions guard workflow |
| `audit [--since <date>] [--limit <n>]` | List local bypasses, and protected-branch commits that didn't come from an approved PR |
| `install --global` / `uninstall [--global]` | Manage hooks for all future clones, or remove them from this clone |
| `studio [--port <n>] [--no-open]` | Open a web UI for all of the above (see [Studio](#studio)) |

GitHub API access (for `audit` and automatic PR creation) uses `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`.

## Studio

Prefer clicking to typing? Run this inside a repository:

```sh
vcs-protection studio          # or: npx vcs-protection studio
```

It starts a small web app on your computer and opens it in the browser. Everything the commands above do is there:

| Section | What you can do |
|---|---|
| **Overview** | See the rules' source (shared or only in this clone), hook health, the guard's state and local bypasses. Run the `doctor` checks and fix broken hooks with one click. In a repository without rules: set up protection (`init`). |
| **Rules** | See, add, edit and remove protected patterns. Choose how to share the change: open a pull request (default), commit on a branch only, or only edit the file. |
| **Guard settings** | Edit enforcement, bypass users, stale approvals, the sweep schedule, the poison pill, the local bypass and `failMode`. Values are validated like the config file, and saved through a pull request. |
| **Hooks** | Hook states, install/refresh, repair, uninstall. |
| **GitHub guard** | Workflow status, write or regenerate the workflow (optionally pinned), and links to the Actions page (for example to run the baseline). |
| **Audit** | Run the audit and read the result as a table; the local bypass log. |
| **Machine** | Install or remove the hooks for every new clone (`install --global`). This is also the only section outside a git repository. |

Every action shows the same messages the command would print, and changes still go through pull requests. Destructive actions (removing a rule, uninstalling hooks) ask first.

- `--port <n>` picks the port (default: any free port); `--no-open` only prints the link (useful over SSH: forward the port first).
- It listens on `127.0.0.1` only, and only answers the page it served: the link carries a one-time token, and requests from other websites are refused. Press **Ctrl+C** to stop it; a new link is printed every time it starts.

## Configuration: `.vcs-protection.json`

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
    "poisonPill": { "enabled": false, "workflows": [], "checks": [], "conclusions": ["failure", "timed_out"] }
  },
  "failMode": "open"
}
```

- **`remote`**: the remote that stands for the shared repository. Letters, digits, `.`, `_` and `-` only.
- **`pattern`**: a branch name or glob. `release/*` matches `release/1.0` but not `release/1.0/x`; use `release/**` for any depth. On Windows and macOS (where git sets `core.ignorecase`), the local hooks match regardless of case, because `MAIN` and `main` are the same branch there; pushes and the GitHub guard stay case-sensitive, like GitHub.
- **`requiredApprovals`**: how many approvals a PR needs. Only reviewers with **write access** count (like GitHub's own protection). Each reviewer's latest review counts, dismissed reviews don't count, and the PR author never counts. Outstanding "changes requested" also fails the check.
- **`bypass.allowed`**: whether `VCS_PROTECTION_BYPASS="<reason>"` works locally. Every use is appended to `.git/vcs-protection/audit.log`.
- **`github.enforcement`**: `revert` resets the branch, saves the commits to a rescue branch and opens an issue. `report` only opens the issue.
- **`github.rescueBranchPrefix`**: where rescued commits go; must be usable as the start of a git branch name.
- **`github.bypassUsers`**: GitHub logins whose direct pushes the guard allows, such as release managers.
- **`github.dismissStaleApprovals`**: when `true`, only approvals of the PR's final commit count; a new push after an approval needs a fresh one.
- **`github.sweep`**: how often the guard re-checks every protected branch (cron); `null` turns the sweep off.
- **`github.guardLogin`**: the bot account whose `vcs-protection/accepted/<branch>` statuses the guard trusts. `github setup` writes it into the workflow; the guard never reads it from a commit. Leave the default unless the guard runs with a GitHub App token.
- **`github.poisonPill`**: revert approved merges that break critical CI workflows. See [Poison pill](#poison-pill).
- **`failMode`**: what the hooks do if the CLI is missing or crashes. `open` warns and allows; `closed` blocks.

**Rules protect themselves.** Hooks read the config from the remote default branch (`origin/HEAD`), not from your working tree. Editing the file on a feature branch changes nothing until that change is approved and merged, and neither does pointing its `remote` somewhere else or breaking its JSON: the working-tree copy is only used when no remote has a config yet. If the rules can't be read at all, the hooks follow the `failMode` they were installed with. The GitHub guard only uses the rules in commits it has verified: an unreviewed commit that deletes the file, breaks it, or removes a branch from `protected` changes nothing, and is itself reverted.

## The GitHub guard

The workflow runs `npx vcs-protection@<version> ci-guard`:

- **Every push, and a sweep every 30 minutes:** the guard judges the branch from its current tip back to the last commit it already verified **for that branch**. It marks verified commits with a `vcs-protection/accepted/<branch>` commit status (a commit verified on `develop` isn't thereby verified on `main`). A commit is fine if it is the merge, squash or rebase-merge of a PR into that branch with enough approvals, or was pushed by a `bypassUsers` login (the guard looks the pusher up in GitHub's activity log, so a release bot's `[skip ci]` push is kept). Because every run re-checks everything unverified, nothing slips through when a run is skipped (`[skip ci]` in a commit message), cancelled, or when a second push lands before the first is judged.
- **Which rules count:** only those in the newest verified commit. They change only through verified commits, so an unreviewed commit can't switch protection off, not even by deleting `.vcs-protection.json`. The account whose markers count (`github-actions[bot]`) comes from the workflow, not from the commits.
- **What happens to violations:** if every commit from the first violation up to the tip is a violation, the branch is moved back to before it; the commits are saved on a rescue branch first. If reviewed work was merged on top of it, nothing is thrown away: the issue lists the commits with the exact `git revert` commands. Force pushes are reset, and protected branches created from unreviewed commits are deleted.
- **The move is atomic:** the branch is updated only if it still points at the commit the guard judged (GraphQL `updateRefs` with an expected value), so a merge that lands meanwhile is never overwritten. If the rescue branch can't be saved, nothing is reset. Runs for the same branch are queued one after another; the issue is written before a commit is marked as reported, so a failure never hides a violation, and overlapping runs don't open the same issue twice.
- **Merges made in the GitHub UI:** if GitHub hasn't linked the merge commit to its PR yet, the guard waits and asks again (up to about 17 seconds) instead of treating it as a direct push.
- **Pull requests into a protected branch:** the guard posts a `vcs-protection/approvals` commit status (for example "1/2 approvals: merging now will be reverted"), so reviewers can see this before they merge.
- **Protected branch deleted:** the guard recreates it at the deleted commit, from GitHub's repository activity log. If that isn't available, it opens an issue with a restore command.

A branch the guard has never verified isn't judged until it has a starting point (see **Starting the guard** above); `vcs-protection audit` checks older history.

### Poison pill

An approved PR can still break the build. With the poison pill on, the guard also watches your critical CI workflows. When one of them fails on a commit pushed to a protected branch, the guard treats it as a breach and runs the same remediation: rescue branch, reset, issue.

```json
"github": {
  "poisonPill": { "enabled": true, "workflows": ["CI"], "checks": ["test"], "conclusions": ["failure", "timed_out"] }
}
```

- **`workflows`** (required when enabled): the `name:` of each critical workflow. The generated guard adds a `workflow_run` trigger for them, so it wakes up when they *finish*. There is no polling or sleep.
- **`checks`**: optional job (check-run) names that count. Empty means every job of the finished workflow.
- **`conclusions`**: check-run results that count as a breach: `failure` and `timed_out` by default; `cancelled`, `action_required` and `startup_failure` are also allowed.

The guard reads the results from GitHub's check-runs API, and only for runs triggered by a `push` (failing PR builds are ignored). It judges by the rules as they were before the commit, and looks at the whole merge (all commits of a rebase merge). Each failing check is compared with the same check of the same workflow before the merge: if it failed there too, the failure is inherited and nothing happens; if it passed, the merge caused it and the branch may be reset; if that earlier run is missing, unfinished or cancelled, the guard only reports. So an innocent PR merged on top of a broken one isn't rolled back. If newer commits already landed on top of the broken one, it does **not** reset the branch. Instead the issue lists the failing checks and gives the exact `git revert` command to undo it through a PR. `github.bypassUsers` doesn't apply to the poison pill. After changing the setting, run `vcs-protection github setup` on the same branch and merge the config and the regenerated workflow together through a PR.

## Limitations

These are guardrails, not a security boundary. Real enforcement needs GitHub's server-side protection: rulesets or branch protection on a plan that includes them for private repos.

- Anyone can remove local hooks (`rm .git/hooks/*`, `vcs-protection uninstall`). `doctor`, the self-repair on checkout/merge, and the GitHub guard reduce the impact.
- `git push --no-verify` skips the `pre-push` check, and nothing else can stop a push locally. The GitHub guard reverts what it lets through.
- Moving a remote-tracking ref by hand (`git update-ref refs/remotes/origin/main <commit>`) and then the branch in a *separate* command looks like a sync to the hooks: locally, that can't be told apart from a fetch. The push is still blocked, and the guard catches it if it is forced through.
- A push to the shared repository is recognised by remote name, by any fetch or push URL of that remote, by GitHub owner/repo, and by local path. Another spelling of a non-GitHub URL (an SSH alias, a different host name) isn't; the guard still catches such a push.
- A push run uses the workflow file **from the pushed commit**, so a direct push that also deletes or edits the guard isn't checked by its own run. The sweep runs from the default branch's copy and catches it within 30 minutes, unless the guard was removed from the default branch too. `[skip ci]` pushes are likewise caught by the next run or the sweep, not instantly.
- The accepted marker trusts statuses from `github-actions[bot]`. A personal token can't post those, but a workflow someone adds on a branch can: deliberate sabotage is possible. `vcs-protection audit` ignores markers.
- The poison pill reports each broken commit once; re-running its CI doesn't open another issue.
- If a reviewed PR is merged on top of an unreviewed commit, the guard reports the commit (with `git revert` steps) instead of resetting.
- A PR merged without enough approvals shows as "merged" on GitHub and is then reverted. The issue and rescue branch explain what happened and how to redo it properly.
- A blocked fast-forward merge or `reset --hard` leaves your files already updated, because git changes them before the branch. The block message prints the exact `git read-tree -m -u <sha> HEAD` command to put them back.

## Development

```sh
npm install
npm run typecheck
npm test          # builds, then runs unit + integration tests (real git repos in temp dirs)
```
