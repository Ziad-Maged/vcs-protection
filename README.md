# vcs-protection

Branch protection for git repositories when GitHub's own branch protection isn't available (for example, private repositories on plans without it).

It works on two layers:

| Layer | What it does | Can it be bypassed? |
|---|---|---|
| **Local git hooks** (every teammate's clone) | Blocks commits, merges, resets, rebases and pushes that would change a protected branch, and **`git commit --no-verify` too** | Only by uninstalling the hooks or using the logged emergency bypass |
| **GitHub Actions guard** (on the remote) | Checks every push to a protected branch. Anything that isn't the merge of a PR with enough approvals is **reverted**: the commits are saved to a rescue branch and an issue is opened | Only by a push that also removes the workflow (see [Limitations](#limitations)) |

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

### Every teammate: automatic on `npm install`

The package has a `postinstall` script, so nobody has to run `init` by hand:

- **Node.js projects (recommended):** add it as a dev dependency once and commit `package.json`. Every `npm install` / `npm ci` in a clone then installs, or refreshes, the hooks in that clone.

  ```sh
  npm i -D vcs-protection
  npm install-scripts approve vcs-protection   # npm >= 12 only: allows its postinstall script
  ```

  npm 12 blocks dependency install scripts unless they are listed in the `allowScripts` field of `package.json`; the second command adds the entry. npm 11 runs the script but prints a warning; earlier versions just run it.
- **Global install:** `npm i -g vcs-protection` (npm >= 12: `npm i -g --allow-scripts=vcs-protection vcs-protection`) sets git's `init.templateDir`, so every future `git clone` gets the hooks. If you already have a different `init.templateDir`, it is left alone; run `vcs-protection install --global --force` to replace it. Clones that already exist still need `vcs-protection init`.

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

GitHub API access (for `audit` and automatic PR creation) uses `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`.

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
    "poisonPill": { "enabled": false, "workflows": [], "checks": [], "conclusions": ["failure", "timed_out"] }
  },
  "failMode": "open"
}
```

- **`pattern`**: a branch name or glob. `release/*` matches `release/1.0` but not `release/1.0/x`; use `release/**` for any depth.
- **`requiredApprovals`**: how many approvals a PR needs. Each reviewer's latest review counts, dismissed reviews don't count, and the PR author never counts. Outstanding "changes requested" also fails the check.
- **`bypass.allowed`**: whether `VCS_PROTECTION_BYPASS="<reason>"` works locally. Every use is appended to `.git/vcs-protection/audit.log`.
- **`github.enforcement`**: `revert` resets the branch, saves the commits to a rescue branch and opens an issue. `report` only opens the issue.
- **`github.bypassUsers`**: GitHub logins whose direct pushes the guard allows, such as release managers.
- **`github.poisonPill`**: revert approved merges that break critical CI workflows. See [Poison pill](#poison-pill).
- **`failMode`**: what the hooks do if the CLI is missing or crashes. `open` warns and allows; `closed` blocks.

**Rules protect themselves.** Hooks read the config from the remote default branch (`origin/HEAD`), not from your working tree. Editing the file on a feature branch changes nothing until that change is approved and merged. The guard judges each push by the config as it was *before* the push.

## The GitHub guard

The workflow runs `npx vcs-protection@<version> ci-guard`:

- **Push to a protected branch:** the push is accepted only if its head commit is the merge commit of a PR into that branch with enough approvals. Force pushes, direct pushes, and PRs merged in the UI with too few approvals are reverted with a compare-and-swap check, so newer pushes are never overwritten.
- **Pull requests into a protected branch:** the guard posts a `vcs-protection/approvals` commit status (for example "1/2 approvals: merging now will be reverted"), so reviewers can see this before they merge.
- **Protected branch deleted:** the guard recreates it when GitHub sends the push event. Otherwise it opens an issue with restore instructions.

"Reverted" means the guard force-resets the branch to the commit before the push, and only while the pushed commit is still the branch tip. This compare-and-swap check means a newer push is never overwritten; in that case the guard only saves the rescue branch and opens the issue.

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

The guard reads the results from GitHub's check-runs API, and only for runs triggered by a `push` (failing PR builds are ignored). It judges by the rules as they were before the commit. A check that already failed on the commit's parent is treated as inherited, so an innocent PR merged on top of a broken one is never rolled back. If newer commits already landed on top of the broken one, it does **not** reset the branch. Instead the issue lists the failing checks and gives the exact `git revert` command to undo it through a PR. `github.bypassUsers` doesn't apply to the poison pill. After changing the setting, run `vcs-protection github setup` on the same branch and merge the config and the regenerated workflow together through a PR.

## Limitations

These are guardrails, not a security boundary. Real enforcement needs GitHub's server-side protection: rulesets or branch protection on a plan that includes them for private repos.

- Anyone can remove local hooks (`rm .git/hooks/*`, `vcs-protection uninstall`). `doctor`, the self-repair on checkout/merge, and the GitHub guard reduce the impact.
- GitHub runs the workflow file **from the pushed commit**, so a direct push that also deletes or edits the guard workflow is not checked. `vcs-protection audit` finds these afterwards.
- A PR merged without enough approvals shows as "merged" on GitHub and is then reverted. The issue and rescue branch explain what happened and how to redo it properly.
- A blocked fast-forward merge or `reset --hard` leaves your files already updated, because git changes them before the branch. The block message prints the exact `git read-tree -m -u <sha> HEAD` command to put them back.

## Development

```sh
npm install
npm run typecheck
npm test          # builds, then runs unit + integration tests (real git repos in temp dirs)
```
