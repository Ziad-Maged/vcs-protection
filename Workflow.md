# vcs-protection: pre-publish end-to-end test workflow

This guide tests every command of `vcs-protection` against a real GitHub repository before the package goes to npm. It starts with building the tarball and ends with a publish checklist. It also covers the automatic setup that the package's npm `postinstall` script performs (Phase 2.3 for global installs, Phase 6.3–6.4 for installs as a project dependency).

- **Test subject:** your personal Express + MongoDB Atlas server repository on GitHub.
- **People:** "you" (the repo owner, `<you>`) and a second GitHub account (`<reviewer>`) who approves pull requests.
- **Shells:** commands are written for **Git Bash**. Where PowerShell differs (mostly environment variables), a PowerShell version follows marked **PS**.
- **Format:** each step has the command(s), an **Expected** result, and a checkbox. Tick it or note what happened instead.

> ⚠️ **Use a disposable copy of the Express repo.** The GitHub guard *rewrites* protected branches, creates rescue branches and opens issues. Phase 3 shows how to mirror your repo into a throwaway private repo (`<you>/express-vcs-test`). Everything below uses that name.

---

## 0. Coverage checklist

| Command / option | Phase |
|---|---|
| `--version`, `--help`, `<command> --help` | 2 |
| `init` (interactive), `init -b -a --github`, `init` on a teammate clone | 4, 6 |
| `list`, `list --json` | 4 |
| `status` | 5, 6 |
| `doctor`, `doctor --fix` | 4, 7 |
| `protect <pattern>` (auto branch + push + PR), `-a/--approvals`, `--allow-deletion`, `--no-push`, `--no-commit` | 9 |
| `unprotect <pattern>`, plus its error cases | 9, 11 |
| `github setup`, `github setup --pin` | 12 |
| `audit`, `audit --since --limit`, `audit` without a token | 12 |
| `install --global`, `install --global --force` | 6 |
| Automatic setup on `npm i -g` (sets `init.templateDir`; leaves a foreign one alone) | 2, 6 |
| Automatic setup on `npm install` as a dependency (hooks → `node_modules` copy), `npm ci` on a fresh clone | 6 |
| `npm install-scripts approve` / `--allow-scripts` (npm ≥ 12) | 2, 6 |
| Opt-outs: `VCS_PROTECTION_SKIP_INSTALL=1`, `CI=true`, `--ignore-scripts` | 6 |
| `npm uninstall` leaves hooks behind; shim falls back to the global CLI | 6 |
| `uninstall`, `uninstall --global` | 7, 14 |
| `hook <name>` (internal, called manually) | 7 |
| `ci-guard` (internal; in Actions, and manually) | 4, 8, 10, 13 |
| `postinstall` (internal; run by npm) | 2, 6 |
| `VCS_PROTECTION_BYPASS` + audit log | 4, 5 |
| Git hooks: reference-transaction, pre-commit, pre-merge-commit, pre-push, post-checkout, post-merge | 5, 7 |

---

## 1. Prerequisites

| Requirement | Check |
|---|---|
| Node.js ≥ 22.12 | `node -v` |
| npm (note the major version: npm ≥ 12 blocks dependency install scripts unless approved, which changes a few commands below) | `npm -v` |
| git ≥ 2.28 (Git for Windows) | `git --version` |
| GitHub CLI, logged in as `<you>` | `gh auth status` (otherwise `gh auth login`) |
| Second GitHub account `<reviewer>` | You can sign in to it in a private browser window |
| MongoDB Atlas cluster | Connection string `mongodb+srv://...`, and your IP allowed under **Network Access** |

Placeholders used throughout:

| Placeholder | Meaning |
|---|---|
| `<you>` | your GitHub login |
| `<reviewer>` | the second account's login |
| `<express-repo>` | your existing Express repository |
| `PKG` | path to this package, e.g. `~/Desktop/projects/vcs-protection` |
| `WORK` | an empty working folder, e.g. `~/vcsp-e2e` |

```bash
export PKG=~/Desktop/projects/vcs-protection
export WORK=~/vcsp-e2e
mkdir -p "$WORK"
```

**PS:**

```powershell
$env:PKG = "$HOME\Desktop\projects\vcs-protection"
$env:WORK = "$HOME\vcsp-e2e"
New-Item -ItemType Directory -Force $env:WORK
```

The automatic setup changes git's global `init.templateDir`. Save the current value first, so you can restore it in Phase 14 (an empty file means it was unset):

```bash
git config --global init.templateDir > "$WORK/templateDir.bak"; cat "$WORK/templateDir.bak"
```

**PS:** `git config --global init.templateDir | Set-Content "$env:WORK\templateDir.bak"`

If this prints `…/.vcs-protection/git-template`, an earlier test run left it behind. Run `vcs-protection uninstall --global` (or delete the line from `~/.gitconfig`) and save the value again, so Phase 2.3 tests a clean first install.

---

## 2. Build, test and package

> There is no `npm package` command. The packaging command is **`npm pack`**. It builds the same `.tgz` that `npm publish` would upload.

### 2.1 Install, typecheck, test

```bash
cd "$PKG"
npm ci
npm run typecheck
npm test
```

**Expected:** `typecheck` prints nothing and exits 0. `npm test` builds `dist/cli.js`, then shows:

```
Test Files  5 passed (5)
     Tests  60 passed (60)
```

- [ ] passed

### 2.2 Inspect the package contents

```bash
npm pack --dry-run
```

**Expected:** exactly 4 files (`README.md`, `dist/cli.js`, `package.json`, `scripts/postinstall.mjs`). `total files: 4`, and the unpacked size is about 1.1 MB. No `src/`, `test/`, `Workflow.md` or `Documentation.md`.

Check that the lifecycle script is declared:

```bash
npm pkg get scripts.postinstall
```

**Expected:** `"node scripts/postinstall.mjs"`.

- [ ] passed

### 2.3 Create the tarball and install it globally (automatic global setup)

```bash
npm pack
npm i -g --foreground-scripts "$PKG/vcs-protection-1.0.0.tgz"
git config --global init.templateDir
```

npm ≥ 12 skips the install script of a package that isn't approved. For a tarball, the approval names the `file:` spec:

```bash
npm i -g --foreground-scripts "--allow-scripts=file:$PKG/vcs-protection-1.0.0.tgz" "$PKG/vcs-protection-1.0.0.tgz"
```

**PS:** `npm i -g --foreground-scripts "--allow-scripts=file:$env:PKG\vcs-protection-1.0.0.tgz" "$env:PKG\vcs-protection-1.0.0.tgz"`

(`--foreground-scripts` only makes npm show the script's output; npm hides it otherwise.)

**Expected:**
- `vcs-protection-1.0.0.tgz` is created in `PKG`, and the global install succeeds.
- The install shows `> node scripts/postinstall.mjs` followed by `✔ vcs-protection: new clones will get the git hooks automatically (init.templateDir=…/.vcs-protection/git-template).`
- `git config --global init.templateDir` prints that directory. **From now on every new clone gets the 6 hooks without `init`** (they stay inactive in repos without a config).
- npm 11 may add `npm warn install-scripts … not yet covered by allowScripts`. That is npm's notice, not an error. On npm ≥ 12 without the `--allow-scripts` flag you see `…had install scripts blocked…` instead, and `init.templateDir` stays unset.
- If `init.templateDir` was already set to something else, the install prints `vcs-protection: git's init.templateDir is already set to '…'; left it unchanged.` and changes nothing (tested again in 6.6).

> Installing the tarball is the closest thing to a real `npm i -g vcs-protection`. For fast code-edit loops you can use `npm link` in `PKG` instead. Re-run `npm pack` + `npm i -g` before any GitHub-side test (Phase 3.4 explains why).

- [ ] passed

### 2.4 Smoke-test the binary

```bash
vcs-protection --version
vcs-protection --help
vcs-protection github --help
vcs-protection protect --help
```

**Expected:**
- `--version` prints `1.0.0`.
- `--help` lists `init, protect, unprotect, list, status, doctor, github, audit, install, uninstall`. The internal commands `hook`, `ci-guard` and `postinstall` are **not** listed.
- `github --help` lists `setup`.
- `protect --help` shows `-a, --approvals`, `--allow-deletion`, `--no-commit` and `--no-push`.

- [ ] passed

---

## 3. Prepare the Express test repository

### 3.1 Make a disposable private copy

On GitHub, create an **empty private** repository `express-vcs-test`, with no README. Then:

```bash
cd "$WORK"
git clone --mirror https://github.com/<you>/<express-repo>.git mirror.git
cd mirror.git && git push --mirror https://github.com/<you>/express-vcs-test.git && cd .. && rm -rf mirror.git
```

**Expected:** `express-vcs-test` on GitHub shows the same files and history as `<express-repo>`. If the original has had pull requests, `! [remote rejected] refs/pull/… (deny updating a hidden ref)` lines are expected and harmless. The default branch is `main` (if yours is `master`, replace `main` with `master` everywhere below).

- [ ] passed

### 3.2 Configure the GitHub repository

In `express-vcs-test` → **Settings**:

1. **Collaborators** → add `<reviewer>`, then accept the invitation from the reviewer account.
2. **Actions → General → Workflow permissions** → **Read and write permissions** → Save.
3. **General → Features** → make sure **Issues** is enabled.

- [ ] done

### 3.3 Clone as "alice" and confirm the app works

```bash
cd "$WORK"
git clone https://github.com/<you>/express-vcs-test.git alice
cd alice
cat .gitignore            # must contain node_modules and .env
```

If `.env` isn't ignored, add it before creating the file:

```bash
echo ".env" >> .gitignore   # only if missing; this change gets committed in step 4.3
```

Create `.env`, using whatever variable name your server reads:

```bash
cat > .env <<'EOF'
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/<db>?retryWrites=true&w=majority
PORT=3000
EOF
npm install
npm start                 # or: node server.js / npm run dev
```

In a second terminal:

```bash
curl -i http://localhost:3000/<one-of-your-routes>
```

**PS:** `curl.exe -i http://localhost:3000/<route>` (plain `curl` in Windows PowerShell 5.1 is `Invoke-WebRequest`).

Because of Phase 2.3, `alice` already has the 6 hooks from the global template (`ls .git/hooks | grep -v sample`). They do nothing yet: the repository has no `.vcs-protection.json`.

**Expected:** the server logs a successful MongoDB connection, and the route returns `200` with data from Atlas. This is the **baseline**. Stop the server with Ctrl+C. Repeat this check at the end (Phase 14) to confirm the package never touched the app.

- [ ] passed

### 3.4 Pre-publish workaround for the GitHub guard

The workflow generated by `vcs-protection` runs `npx --yes vcs-protection@1.0.0 ci-guard`. That can't work until the package is on npm. For testing, the workflow instead installs the tarball, which you commit into the test repo under `.vcs-protection-dev/`.

Save this script **outside** the test repo as `$WORK/dev-patch-workflow.mjs`:

```js
// Usage: node dev-patch-workflow.mjs <repo-root>
// Makes the generated guard workflow install vcs-protection from a committed tarball.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.argv[2] ?? '.';
const file = path.join(root, '.github', 'workflows', 'vcs-protection-guard.yml');
let yml = readFileSync(file, 'utf8');
if (yml.includes('.vcs-protection-dev/')) {
  console.log('already patched');
  process.exit(0);
}
const step = /      - name: vcs-protection guard\r?\n        run: npx --yes vcs-protection@\S+ ci-guard\r?\n/;
if (!step.test(yml)) {
  console.error('unexpected workflow format, not patched');
  process.exit(1);
}
yml = yml.replace(
  step,
  [
    '      - uses: actions/checkout@v4',
    '        with:',
    '          ref: ${{ github.event.repository.default_branch }}',
    '      - name: vcs-protection guard (pre-publish tarball)',
    '        run: npm i -g ./.vcs-protection-dev/vcs-protection.tgz && vcs-protection ci-guard',
    '',
  ].join('\n'),
);
writeFileSync(file, yml);
console.log('patched', file);
```

> The runner sets `CI=true`, so installing the tarball in Actions skips the automatic hook setup (nothing is written to the runner's checkout). GitHub's runners currently ship npm 10 or 11; if a runner ever has npm ≥ 12 the script is simply blocked, which is equally harmless: `ci-guard` doesn't need it.

> ⚠️ **Re-patch after every command that regenerates the workflow:** `init --github`, `github setup`, `protect` and `unprotect`. The steps below remind you. While patched, `doctor` reports `✖ GitHub guard … out of date`. That is expected before publishing.

- [ ] saved

---

## 4. Bootstrap protection (you, in `alice`)

### 4.1 Interactive `init` (then undo it)

```bash
cd "$WORK/alice"
vcs-protection init
```

**Expected:** two prompts:
- `Branches to protect (comma-separated, globs allowed) (main):` press Enter.
- `Required approvals per pull request (1):` press Enter.

Then:
- `✔ Created .vcs-protection.json protecting: main`
- `✔ Installed git hooks in …\alice\.git\hooks: reference-transaction, pre-commit, pre-merge-commit, pre-push, post-checkout, post-merge`
- the tip ``Tip: run `vcs-protection github setup` …``
- the **Next: share the rules with your team** block.

Undo it, so the non-interactive form can be tested:

```bash
rm .vcs-protection.json
```

- [ ] passed

### 4.2 Non-interactive `init` with the GitHub guard

```bash
vcs-protection init --branches main --approvals 1 --github
node "$WORK/dev-patch-workflow.mjs" .
mkdir -p .vcs-protection-dev && cp "$PKG/vcs-protection-1.0.0.tgz" .vcs-protection-dev/vcs-protection.tgz
```

**Expected:**
- `✔ Created .vcs-protection.json protecting: main`
- `✔ Installed git hooks …` (all 6 hooks)
- `✔ Wrote GitHub guard workflow: .github\workflows\vcs-protection-guard.yml`
- the patch script prints `patched …vcs-protection-guard.yml`

Inspect the files:

```bash
cat .vcs-protection.json
cat .github/workflows/vcs-protection-guard.yml
head -8 .git/hooks/pre-push
```

**Expected:**
- The config has `"version": 1`, `"remote": "origin"`, one rule `{"pattern":"main","requiredApprovals":1,"allowDeletion":false}`, `"bypass": {"allowed": true}`, `"enforcement": "revert"` and `"failMode": "open"`.
- The workflow triggers on `push` to `'main'`, plus `delete`, `pull_request` and `pull_request_review`, and has the patched checkout + tarball step.
- The hook starts with `#!/bin/sh` and `# vcs-protection:managed`, and `VCSP_NODE`/`VCSP_CLI` point to your Node and the global `…/node_modules/vcs-protection/dist/cli.js`.

If your Express repo uses husky (`core.hooksPath`), `init` also prints ``core.hooksPath is set to '…'; hooks are installed there and chained with existing ones.``

- [ ] passed

### 4.3 `list`, `list --json`, `doctor` before the rules are shared

```bash
vcs-protection list
vcs-protection list --json
vcs-protection doctor; echo "exit=$?"
```

**PS:** `vcs-protection doctor; "exit=$LASTEXITCODE"`

**Expected:**
- `list` shows `Rules from …\alice\.vcs-protection.json (local)` and `main   approvals: 1   deletion: blocked`.
- `list --json` returns JSON with `"source": "local"`.
- `doctor` shows ✔ for git version, config, core.hooksPath and all 6 hooks, plus these two failures, and `exit=1`:
  - `✖ config shared   .vcs-protection.json is not on the remote default branch yet; …`
  - `✖ GitHub guard    branch list out of date …` (because of the patch; expected)

- [ ] passed

### 4.4 Bootstrap commit and push with the bypass

The rules already apply locally, so committing to `main` needs the logged bypass. This is the documented one-time bootstrap.

```bash
git add .vcs-protection.json .github/workflows/vcs-protection-guard.yml .vcs-protection-dev .gitignore
VCS_PROTECTION_BYPASS="initial setup" git commit -m "chore: add vcs-protection"
VCS_PROTECTION_BYPASS="initial setup" git push origin main
```

**PS:**

```powershell
$env:VCS_PROTECTION_BYPASS = "initial setup"
git commit -m "chore: add vcs-protection"
git push origin main
Remove-Item Env:VCS_PROTECTION_BYPASS
```

**Expected:** the commit and the push each print:

```
[vcs-protection] Protection bypassed for 'main' (VCS_PROTECTION_BYPASS="initial setup"). This was logged.
```

- [ ] passed

### 4.5 First guard run on GitHub

Open **Actions → vcs-protection guard** for this push.

**Expected:** a green run whose log/summary says `No .vcs-protection.json at <sha>; nothing to enforce.` The guard judges a push by the rules as they were *before* it, and there were none.

- [ ] passed

### 4.6 `list` now reads the rules from the remote

```bash
vcs-protection list
vcs-protection doctor
```

**Expected:**
- `list` shows `Rules from refs/remotes/origin/main:.vcs-protection.json (remote)`.
- `doctor` no longer shows `config shared`. Only `GitHub guard` is ✖ (patched).

- [ ] passed

---

## 5. Local enforcement (alice)

Every blocked operation prints a red box that starts with `✖ [vcs-protection]`. For operations stopped by the reference-transaction hook, git adds `fatal: ref updates aborted by hook`.

### 5.1 Direct commit on `main`

```bash
git switch main
echo "// test" >> README.md
git add README.md
git commit -m "direct commit"
```

**Expected:** blocked **before the editor opens** (by the pre-commit hook):

```
✖ [vcs-protection] Direct commits to protected branch 'main' are not allowed.
  Changes reach 'main' only through a pull request on GitHub approved by 1 other team member.
  Move your work to a new branch: git switch -c <feature-branch>

  Emergency only: VCS_PROTECTION_BYPASS="<reason>" <command> (logged; the GitHub guard may still revert it).
```

`git log -1` is unchanged.

- [ ] passed

### 5.2 Direct commit with `--no-verify`

```bash
git commit --no-verify -m "sneaky commit"
git log --oneline -1
```

**Expected:** the same message, followed by `fatal: ref updates aborted by hook`. `git log` still shows the bootstrap commit. **This is the key test.**

- [ ] passed

### 5.3 Move the work to a feature branch and push it

```bash
git switch -c feature/readme
git commit -m "docs: readme tweak"
git push -u origin feature/readme
```

**Expected:** the commit and the push succeed without any vcs-protection output. The staged change carried over to the new branch.

- [ ] passed

### 5.4 Fast-forward merge into `main`

```bash
git switch main
git merge feature/readme
```

**Expected:**

```
✖ [vcs-protection] Merging into protected branch 'main' is not allowed.
  Merges into 'main' must go through a pull request on GitHub approved by 1 other team member.
  Push the branch: git push -u origin feature/readme
  Open a pull request: https://github.com/<you>/express-vcs-test/compare/main...feature/readme?expand=1

  Git already updated your files, but 'main' did not move. Restore them (keeps your other local edits):
    git read-tree -m -u <sha12> HEAD
  …
fatal: ref updates aborted by hook
```

Run the printed `read-tree` command, then check:

```bash
git read-tree -m -u <sha12> HEAD
git status --short
```

**Expected:** `git status --short` prints nothing.

- [ ] passed

### 5.5 `--no-ff` merge (with `--no-verify`)

```bash
git merge --no-ff --no-verify --no-edit feature/readme
git merge --abort
git status --short
```

**Expected:** the `Merging into protected branch 'main'` message, now with `Undo the attempted merge with: git merge --abort`, then `fatal: ref updates aborted by hook`. After `--abort`, the working tree is clean.

Without `--no-verify`, the pre-merge-commit hook blocks the same merge earlier.

- [ ] passed

### 5.6 Rebase and cherry-pick onto `main`

```bash
git rebase feature/readme
git rebase --abort
git cherry-pick feature/readme
git cherry-pick --abort
git status --short
```

**Expected:**
- The rebase is blocked with the `Merging into protected branch 'main'` message (feature/readme sits directly on top of main, so it is a fast-forward).
- The cherry-pick is blocked with `Direct commits to protected branch 'main' …` plus `Abort with: git cherry-pick --abort`.
- After both aborts the tree is clean, and `git log -1` is unchanged.

- [ ] passed

### 5.7 Reset `main` to local-only history

```bash
git reset --hard feature/readme
git log --oneline -1
```

**Expected:** blocked with a `Merging into protected branch 'main'` message and a `git read-tree -m -u …` restore hint. `main` doesn't move. Run the hint so `git status --short` is empty again.

- [ ] passed

### 5.8 Pushes to protected branches

```bash
git push origin feature/readme:main
git push origin :main
```

**Expected:**
- The first push is blocked by pre-push:
  ```
  ✖ [vcs-protection] Pushing directly to protected branch 'main' is not allowed.
    …
    Push to a feature branch instead: git push -u origin HEAD:feature/readme
    Open a pull request: https://github.com/<you>/express-vcs-test/compare/main...feature/readme?expand=1
  ```
  followed by `error: failed to push some refs`.
- The second push shows `✖ [vcs-protection] Deleting protected branch 'main' is not allowed.`
- GitHub shows no change.

- [ ] passed

### 5.9 Syncing is allowed

```bash
git fetch
git reset --hard origin/main
git pull
```

**Expected:** all three succeed silently. Moving `main` to commits that already exist on `origin/main` is always allowed.

- [ ] passed

### 5.10 Bypass and `status`

```bash
echo "bypass test" > bypass.txt && git add bypass.txt
VCS_PROTECTION_BYPASS="e2e bypass test" git commit -m "bypass test"
vcs-protection status
```

**PS:** `$env:VCS_PROTECTION_BYPASS="e2e bypass test"; git commit -m "bypass test"; Remove-Item Env:VCS_PROTECTION_BYPASS`

**Expected:**
- The commit succeeds and prints `Protection bypassed for 'main' (VCS_PROTECTION_BYPASS="e2e bypass test"). This was logged.`
- `status` shows the rules, `Hooks (…):` with 6 × `✔ … installed`, and `Local bypasses logged: 3 (last: <timestamp>)`.

Undo the local commit. **Don't push it:**

```bash
git reset --hard origin/main
```

- [ ] passed

---

## 6. Teammates: manual `init`, automatic setup on `npm install`, and the global template

### 6.1 `init` in a second clone

```bash
cd "$WORK"
git clone https://github.com/<you>/express-vcs-test.git bob
cd bob
ls .git/hooks | grep -v sample
vcs-protection init
vcs-protection status
```

**Expected:**
- `ls` already shows the 6 hooks. They were copied from the global template (Phase 2.3), and they are **already active**: `origin/main` now has `.vcs-protection.json`.
- `init` prints `✔ Using rules from refs/remotes/origin/main:.vcs-protection.json` and `✔ Installed git hooks …` (it refreshes them). There are **no** prompts, and no "Next: share the rules" block.
- `status` shows `(remote)` and `Local bypasses logged: 0`.

- [ ] passed

### 6.2 Bob is blocked too

```bash
echo x > bob.txt && git add bob.txt && git commit -m "bob direct"
git reset -q && rm bob.txt
```

**Expected:** `Direct commits to protected branch 'main' are not allowed.`

- [ ] passed

### 6.3 Automatic setup when the project depends on vcs-protection

This is the recommended team setup: the package is a dev dependency, so `npm install` in any clone installs the hooks. Use a separate clone `dave`. The `package.json` changes made here are **not** committed.

To test the real code path, and not the global template, clone with an empty template:

```bash
cd "$WORK"
git clone --template= https://github.com/<you>/express-vcs-test.git dave
cd dave
ls .git/hooks                           # No such file or directory
npm install --foreground-scripts -D "$PKG/vcs-protection-1.0.0.tgz"
```

**Expected (npm ≤ 11):** among the npm output:

```
> vcs-protection@1.0.0 postinstall
> node scripts/postinstall.mjs
✔ vcs-protection: installed git hooks in …/dave/.git/hooks: reference-transaction, pre-commit, pre-merge-commit, pre-push, post-checkout, post-merge
```

There is no `No .vcs-protection.json yet` note, because `origin/main` has the rules.

**npm ≥ 12:** the install ends with `npm warn install-scripts 1 package had install scripts blocked …` and no hooks are written. Approve the package (this adds an `allowScripts` entry to `package.json`, which a real team commits once) and reinstall:

```bash
npm install-scripts approve vcs-protection
cat package.json | grep -A2 allowScripts
npm install --foreground-scripts
```

**Expected:** `allowScripts` lists the tarball's `file:` spec (it would be `vcs-protection` for a registry install), and the `npm install` now prints the `✔ vcs-protection: installed git hooks …` line.

Check where the hooks point, and that they work:

```bash
grep -E "VCSP_(NODE|CLI)=" .git/hooks/pre-commit
npx vcs-protection status
echo x > d.txt && git add d.txt && git commit -m "dave direct"; git reset -q; rm d.txt
```

**Expected:**
- `VCSP_CLI` is `…/dave/node_modules/vcs-protection/dist/cli.js` (the project's copy, **not** the global one).
- `npx vcs-protection status` (the local copy) shows 6 × `✔ … installed`.
- The commit is blocked with `Direct commits to protected branch 'main' are not allowed.`

Also check that the global CLI sees these hooks as belonging to another installation:

```bash
vcs-protection status
```

**Expected:** 6 × `✖ … outdated`. This is normal: `status`/`doctor` compare the hooks with the CLI that runs them. In a project with the local dependency, use `npx vcs-protection …`. (Don't run the global `doctor --fix` here: it would repoint the hooks at the global CLI.)

Now simulate a teammate's fresh checkout, where `package.json` already lists (and approves) the dependency:

```bash
rm .git/hooks/pre-commit .git/hooks/pre-push
rm -rf node_modules
npm ci
ls .git/hooks | grep -v sample
```

**Expected:** `npm ci` prints nothing from vcs-protection (npm hides dependency script output) but the 6 hooks are back. `npx vcs-protection status` is all ✔.

Upgrading the dependency refreshes the hooks: edit one hook by hand, then reinstall:

```bash
echo "# edited" >> .git/hooks/post-merge
npx vcs-protection status | grep post-merge     # outdated
npm ci
npx vcs-protection status | grep post-merge     # installed
```

- [ ] passed

### 6.4 When the automatic setup does nothing

Each case starts from a clone without hooks. Run in `dave`:

```bash
reset_hooks() { for h in reference-transaction pre-commit pre-merge-commit pre-push post-checkout post-merge; do rm -f ".git/hooks/$h"; done; }

reset_hooks; VCS_PROTECTION_SKIP_INSTALL=1 npm ci --foreground-scripts; ls .git/hooks | grep -v sample
reset_hooks; CI=true npm ci --foreground-scripts; ls .git/hooks | grep -v sample
reset_hooks; npm ci --ignore-scripts; ls .git/hooks | grep -v sample
```

**PS:**

```powershell
function Reset-Hooks { "reference-transaction","pre-commit","pre-merge-commit","pre-push","post-checkout","post-merge" | ForEach-Object { Remove-Item -ErrorAction SilentlyContinue ".git\hooks\$_" } }
Reset-Hooks; $env:VCS_PROTECTION_SKIP_INSTALL="1"; npm ci --foreground-scripts; Remove-Item Env:VCS_PROTECTION_SKIP_INSTALL; Get-ChildItem .git\hooks
Reset-Hooks; $env:CI="true"; npm ci --foreground-scripts; Remove-Item Env:CI; Get-ChildItem .git\hooks
Reset-Hooks; npm ci --ignore-scripts; Get-ChildItem .git\hooks
```

**Expected:** all three `npm ci` runs succeed, and **no** vcs-protection hooks are written (only `*.sample` files). With `--foreground-scripts`, the first two show `> node scripts/postinstall.mjs` and nothing after it.

A failing setup must never break `npm install`. Make the hooks directory unwritable and install again:

```bash
reset_hooks; chmod a-w .git/hooks
npm ci --foreground-scripts; echo "exit=$?"
chmod u+w .git/hooks
```

**Expected:** `[vcs-protection] Automatic setup skipped: EACCES …` plus `Run \`vcs-protection init\` …`, and `exit=0`. (Skip this check on Windows, where `chmod` has no effect.)

Outside a git repository, the setup is a no-op:

```bash
mkdir -p "$WORK/plain" && cd "$WORK/plain" && npm init -y >/dev/null
npm install --foreground-scripts "$PKG/vcs-protection-1.0.0.tgz"     # npm ≥ 12: approve first, as in 6.3
cd "$WORK" && rm -rf plain
```

**Expected:** `vcs-protection: …/plain is not inside a git working tree; no hooks installed.` and a successful install.

Finally, removing the dependency does **not** remove the hooks (npm has had no uninstall scripts since v7):

```bash
cd "$WORK/dave"
npm ci
npm uninstall vcs-protection
grep VCSP_CLI= .git/hooks/pre-commit
echo x > d.txt && git add d.txt && git commit -m "after npm uninstall"; git reset -q; rm d.txt
```

**Expected:** the hooks still point at the deleted `node_modules/…/cli.js`. The shim falls back to the `vcs-protection` on your `PATH` (the global install), so the commit is **still blocked**. Without a global install it would print `CLI not found: branch protection is NOT active` and allow the commit (fail-open, see 7.5). The right way to remove it is `npx vcs-protection uninstall` **before** `npm uninstall`.

Clean up `dave`:

```bash
vcs-protection uninstall
git checkout -- package.json package-lock.json
cd "$WORK" && rm -rf dave
```

- [ ] passed

### 6.5 The global template covers every future clone

Phase 2.3 already set `init.templateDir`. Check that a new clone is protected with no command at all:

```bash
git config --global init.templateDir
cd "$WORK" && git clone https://github.com/<you>/express-vcs-test.git carol
ls carol/.git/hooks | grep -v sample
cd carol && echo x > c.txt && git add c.txt && git commit -m c; git reset -q; rm c.txt; cd ..
```

**Expected:**
- `init.templateDir` is `…/.vcs-protection/git-template`.
- `carol` has the 6 hooks **without** running `init`.
- The commit on `main` is blocked.

- [ ] passed

### 6.6 `install --global`, the conflict with `--force`, and a reinstall with a foreign template

```bash
vcs-protection install --global                         # idempotent
git config --global init.templateDir "$WORK/other-template"
vcs-protection install --global; echo "exit=$?"
npm i -g --foreground-scripts "$PKG/vcs-protection-1.0.0.tgz"   # npm ≥ 12: add the --allow-scripts flag from 2.3
git config --global init.templateDir
vcs-protection install --global --force
git config --global init.templateDir
```

**Expected:**
- The first command prints `✔ New clones will get vcs-protection hooks automatically (init.templateDir=…)` again.
- The second is refused with `init.templateDir is already set to '…other-template'. Re-run with --force to replace it.` and `exit=1`.
- Reinstalling the package succeeds and prints `vcs-protection: git's init.templateDir is already set to '…other-template'; left it unchanged.` and the `install --global --force` hint. `init.templateDir` is still `…other-template`.
- `--force` succeeds, and `init.templateDir` is back to `…/.vcs-protection/git-template`.

- [ ] passed

---

## 7. Hook management (in `alice`)

### 7.1 Chaining an existing hook

```bash
cd "$WORK/alice"
vcs-protection uninstall
printf '#!/bin/sh\necho "legacy pre-commit ran"\n' > .git/hooks/pre-commit
vcs-protection init
git switch -c feature/chain && echo y > chain.txt && git add chain.txt && git commit -m chain
```

**Expected:**
- `uninstall` prints `✔ Removed hooks: reference-transaction, pre-commit, … (chained *.local hooks were restored).`
- `init` prints `Existing hooks kept and chained as *.local: pre-commit`.
- The commit prints `legacy pre-commit ran` and succeeds.

- [ ] passed

### 7.2 `uninstall` restores the original hook

```bash
vcs-protection uninstall
cat .git/hooks/pre-commit
```

**Expected:** `.git/hooks/pre-commit` is your legacy script again. Then clean up and reinstall:

```bash
rm .git/hooks/pre-commit
vcs-protection init
git switch main
```

- [ ] passed

### 7.3 Tampering: `doctor`, self-repair, `doctor --fix`

```bash
rm .git/hooks/reference-transaction
vcs-protection doctor; echo "exit=$?"
git switch feature/chain && git switch main
rm .git/hooks/pre-push
vcs-protection doctor --fix
```

**Expected:**
- `doctor` shows `✖ hook reference-transaction   missing`, then ``Run `vcs-protection doctor --fix` to repair hooks.`` and `exit=1`.
- The first `git switch` prints `[vcs-protection] Repaired git hooks: reference-transaction` (post-checkout self-repair).
- `doctor --fix` shows `✔ hook pre-push   repaired`. Only `GitHub guard` stays ✖ (patched).

- [ ] passed

### 7.4 Calling the internal `hook` command directly

```bash
echo "refs/heads/feature/chain $(git rev-parse feature/chain) refs/heads/main $(git rev-parse origin/main)" \
  | vcs-protection hook pre-push origin https://github.com/<you>/express-vcs-test.git
echo "exit=$?"
vcs-protection hook not-a-hook; echo "exit=$?"
```

**Expected:**
- The first command prints the `Pushing directly to protected branch 'main'` box and `exit=1`.
- The second prints `[vcs-protection] Unknown hook 'not-a-hook'.` and `exit=1`.

- [ ] passed

### 7.5 The CLI is missing (`failMode: "open"`)

```bash
npm uninstall -g vcs-protection
echo z > z.txt && git add z.txt && git commit -m "while cli missing"
```

**Expected:** `[vcs-protection] CLI not found: branch protection is NOT active. Reinstall: npm i -g vcs-protection && vcs-protection init`. The commit **succeeds**, because fail-open doesn't lock people out.

Reinstall and clean up:

```bash
npm i -g "$PKG/vcs-protection-1.0.0.tgz"     # npm ≥ 12: add the --allow-scripts flag from 2.3
git reset --hard origin/main
vcs-protection doctor
```

**Expected:** `reset --hard origin/main` is allowed, and `doctor` shows all hooks ✔ again. The reinstall's postinstall finds `init.templateDir` already pointing at its template and just refreshes it.

> `failMode: "closed"` blocks in this situation instead. Changing it is a rules change, so it only takes effect after the change is merged. Optionally test it with the Phase 9 flow.

- [ ] passed

---

## 8. Pull requests and the approvals guard

### 8.1 Open a PR: the status shows missing approvals

```bash
cd "$WORK/alice"
git switch feature/readme
gh pr create --base main --head feature/readme --title "docs: readme tweak" --body "e2e test"
```

**Expected:** in the PR's checks:
- the **vcs-protection guard** job is green
- a commit status **`vcs-protection/approvals`** is ❌ with `0/1 approvals: merging now will be reverted`

- [ ] passed

### 8.2 Merge without approval: the guard reverts it

Click **Merge pull request** on GitHub. Nothing stops you, because there is no server-side branch protection.

**Expected, within about a minute:**
- The Actions run for the push to `main` is **red**. Its summary shows:
  ```
  ❌ Pull request #<n> was merged into 'main' without the required approvals (0/1 approvals).
  - Saved the pushed commits on branch 'vcs-protection/rescue/main-<sha7>'.
  - Reset 'main' back to <sha7-before>.
  - Opened issue https://github.com/<you>/express-vcs-test/issues/<k>
  ```
- `main` on GitHub no longer contains the change. The branch `vcs-protection/rescue/main-<sha7>` exists.
- The issue is titled `vcs-protection: insufficient-approvals on main (<sha7>)` and mentions `@<you>`, the PR link, the actions taken, and a compare link to open a PR from the rescue branch.

Local recovery in clones that already pulled the reverted commit:

```bash
git fetch && git switch main && git reset --hard origin/main
```

**Expected:** allowed. Don't use `git pull` here: it would try to create a merge commit on `main`, which gets blocked.

- [ ] passed

### 8.3 Changes requested

Open a PR from the rescue branch using the link in the issue. As `<reviewer>`, choose **Request changes**.

**Expected:** `vcs-protection/approvals` shows ❌ `Changes requested by <reviewer>: merging now will be reverted`.

- [ ] passed

### 8.4 Approved PR: the guard keeps it

As `<reviewer>`, submit a new review with **Approve**.

**Expected:** `vcs-protection/approvals` turns ✅ `1/1 approvals: OK to merge`.

Merge the PR as `<you>`.

**Expected:** the guard run for the push is **green**: `✅ refs/heads/main: merged from PR #<n> (1/1 approvals)`. `main` keeps the change.

Sync your clones:

```bash
cd "$WORK/alice" && git switch main && git pull
cd "$WORK/bob" && git pull
```

- [ ] passed

> The rule that the author's own approval never counts is covered by unit tests. GitHub doesn't let authors approve their own PRs anyway.

---

## 9. Changing rules: `protect`

These commands need a token to open the PR automatically. `gh auth login` is enough.

### 9.1 `protect "release/*" -a 2`: automatic branch, push and PR

```bash
cd "$WORK/alice" && git switch main
vcs-protection protect "release/*" -a 2
```

**Expected:**

```
✔ 'release/*' is now protected (2 approval(s) required).
✔ Created branch vcs-protection/rules-<timestamp>
✔ Committed .vcs-protection.json, .github/workflows/vcs-protection-guard.yml on vcs-protection/rules-<timestamp>
✔ Pushed vcs-protection/rules-<timestamp>
✔ Opened pull request: https://github.com/<you>/express-vcs-test/pull/<n>
```

Without a token, the last line is `Open the pull request: https://github.com/…/compare/main...vcs-protection/rules-…`.

`protect` regenerated the workflow, which removed the patch. Re-apply it on the same PR branch:

```bash
node "$WORK/dev-patch-workflow.mjs" .
git commit -am "dev: re-apply tarball patch" && git push
```

- [ ] passed

### 9.2 Rules only apply after the merge

In `bob`, before merging:

```bash
cd "$WORK/bob" && git fetch && vcs-protection list
```

**Expected:** only `main` is listed. The PR isn't merged yet.

As `<reviewer>`, approve the rules PR. You need only 1 approval, because the guard judges the merge by the rules *before* it, where `main` needs 1. Then merge it.

**Expected:** a green guard run.

```bash
git pull && vcs-protection list
```

**Expected:** `main` (1 approval) and `release/*` (2 approvals, deletion blocked) are listed. `.github/workflows/vcs-protection-guard.yml` now also triggers on `'release/*'`.

- [ ] passed

### 9.3 `protect --allow-deletion --no-push`, and `protect --no-commit`

```bash
cd "$WORK/alice" && git switch main && git pull
vcs-protection protect "hotfix/*" --allow-deletion --no-push
git log --oneline -1
git branch --show-current
```

**Expected:**
- `✔ 'hotfix/*' is now protected (1 approval(s) required).`
- `✔ Created branch vcs-protection/rules-<ts>`
- `✔ Committed …`
- `Push vcs-protection/rules-<ts> and open a pull request into main.`

Nothing is pushed. `git log` shows `chore(vcs-protection): protect hotfix/*`.

```bash
vcs-protection protect "staging" --no-commit
git status --short
```

**Expected:** `✔ 'staging' is now protected …`, then `Commit .vcs-protection.json and .github/workflows/vcs-protection-guard.yml and open a pull request to share this change.` Both files are modified, and nothing is committed.

Throw away both experiments:

```bash
git checkout -- . && git switch main && git branch -D $(git branch --list "vcs-protection/rules-*" --format="%(refname:short)")
```

**PS:** `git checkout -- .; git switch main; git branch --list "vcs-protection/rules-*" --format="%(refname:short)" | ForEach-Object { git branch -D $_ }`

- [ ] passed

### 9.4 Input errors

```bash
vcs-protection protect x -a -1 --no-commit; echo "exit=$?"
vcs-protection unprotect release/1.0 --no-commit; echo "exit=$?"
vcs-protection unprotect nope --no-commit; echo "exit=$?"
```

**Expected:**
- `Invalid --approvals: -1`
- `'release/1.0' is protected by pattern 'release/*'. Unprotect that pattern instead.`
- `'nope' is not protected.`

All three exit with `exit=1`, and the config is unchanged.

- [ ] passed

---

## 10. Guard violations (server side)

Every violation should produce a **red** Actions run, a rescue branch (except for deletions), and an issue titled `vcs-protection: <kind> on <branch> (<sha7>)`. After each one, resync with `git fetch && git reset --hard origin/<branch>`.

### 10.1 Direct push that bypasses the local hook

```bash
cd "$WORK/alice"
git switch -c feature/direct && echo d > direct.txt && git add direct.txt && git commit -m "direct push"
git push --no-verify origin feature/direct:main
```

**Expected:**
- The push succeeds locally, because `--no-verify` skips pre-push.
- The guard then:
  - reports `❌ Commit <sha7> was pushed directly to 'main' instead of being merged from a pull request.`
  - saves the commit on `vcs-protection/rescue/main-<sha7>`
  - resets `main` to its previous commit
  - opens the issue `vcs-protection: direct-push on main (<sha7>)`

- [ ] passed

### 10.2 Force push

```bash
git fetch
git push --no-verify --force origin origin/main~1:main
```

**Expected:** the guard reports `Force push to protected branch 'main'.` and resets `main` back. The rescue branch points to the older commit you pushed. An issue titled `force-push on main` is opened.

- [ ] passed

### 10.3 Creating a protected branch from unreviewed commits

```bash
git push --no-verify origin feature/direct:release/2.0
```

**Expected:**
- `Protected branch 'release/2.0' was created from commits that are not on 'main'.`
- `Saved the pushed commits on branch 'vcs-protection/rescue/release/2.0-<sha7>'.`
- `Deleted 'release/2.0', which was created from unreviewed commits.`
- An issue titled `created on release/2.0` is opened.

- [ ] passed

### 10.4 Creating a protected branch from `main` is allowed

```bash
git fetch
VCS_PROTECTION_BYPASS="cut release" git push origin origin/main:refs/heads/release/1.0
```

**PS:** `$env:VCS_PROTECTION_BYPASS="cut release"; git push origin origin/main:refs/heads/release/1.0; Remove-Item Env:VCS_PROTECTION_BYPASS`

**Expected:**
- Locally, a bypass warning (pre-push blocks any push to `release/*`) plus the audit log entry.
- On GitHub, a green guard run: `✅ refs/heads/release/1.0: created from existing 'main' history`. The branch stays.

- [ ] passed

### 10.5 Deleting a protected branch

```bash
git push --no-verify origin :release/1.0
```

**Expected, either one of these:**
- **(a)** A push-triggered run: `Protected branch 'release/1.0' was deleted.` → `Restored 'release/1.0' at <sha7>.` plus an issue.
- **(b)** Only the `delete`-triggered run fires. After about 20 seconds it opens the issue `vcs-protection: protected branch release/1.0 deleted`, with restore instructions (`git push origin origin/release/1.0:refs/heads/release/1.0`).

Write down which one happened. If (b), restore the branch with the command from the issue (it needs the bypass, because pre-push protects `release/*`).

- [ ] passed (a / b: ____)

### 10.6 Optional: `github.bypassUsers` and `enforcement: "report"`

Using the Phase 9 flow, edit the config on a PR branch:
- **(A)** Add `"bypassUsers": ["<you>"]` under `github`. Merge it with `<reviewer>`'s approval. Repeat 10.1.

  **Expected:** a green run: `✅ refs/heads/main: <you> is in github.bypassUsers`. The commit stays.

  Remove the setting afterwards the same way.
- **(B)** Set `"enforcement": "report"`, merge it, and repeat 10.1.

  **Expected:** a red run and an issue whose Actions list says `Enforcement is "report": nothing was reverted.`. `main` keeps the commit.

  Revert the setting afterwards, and remove the commit via a PR.

- [ ] passed / skipped

---

## 11. Changing rules: `unprotect`

### 11.1 `unprotect main`: still protected until merged

```bash
cd "$WORK/alice" && git switch main && git fetch && git reset --hard origin/main
vcs-protection unprotect main
node "$WORK/dev-patch-workflow.mjs" . && git commit -am "dev: re-apply tarball patch" && git push
```

**Expected:**
- `✔ 'main' removed from protected branches.`
- `It stays protected for everyone until this change is merged into the default branch.`
- Then the branch, commit, push and PR lines from 9.1.

In `bob`, before merging, `git commit` on `main` is still blocked.

- [ ] passed

### 11.2 Merge, then `main` is free

As `<reviewer>`, approve the PR, then merge it. The guard judges this merge with `main` still protected, so it needs the approval.

```bash
cd "$WORK/bob" && git pull
vcs-protection list
echo free > free.txt && git add free.txt && git commit -m "allowed now" && git push
```

**Expected:**
- `list` shows only `release/*`.
- The commit and the push succeed with no vcs-protection output.
- The guard doesn't run for this push, because `main` is no longer in the workflow's branch filter.

- [ ] passed

### 11.3 Re-protect `main`

```bash
vcs-protection protect main -a 1
node "$WORK/dev-patch-workflow.mjs" . && git commit -am "dev: re-apply tarball patch" && git push
```

As `<reviewer>`, approve and merge. Then run `git pull` in `alice` and `bob`.

**Expected:** `list` shows `main` and `release/*` again, and direct commits on `main` are blocked again.

- [ ] passed

---

## 12. `github setup` and `audit`

### 12.1 `github setup` and `--pin`

```bash
cd "$WORK/alice" && git switch -c chore/regen-guard
vcs-protection github setup --pin 1.0.0
git diff --stat
vcs-protection github setup
```

**Expected:**
- `✔ Wrote .github\workflows\vcs-protection-guard.yml (runs vcs-protection@1.0.0)`, followed by the three "the guard will…" bullets and the Workflow permissions reminder.
- `git diff` shows the patch was removed and `npx --yes vcs-protection@1.0.0 ci-guard` is back.

Re-patch and throw the branch away:

```bash
node "$WORK/dev-patch-workflow.mjs" . && git diff --stat   # no diff left
git switch main && git branch -D chore/regen-guard
```

- [ ] passed

### 12.2 `audit` with a token

```bash
vcs-protection audit --since "1 day ago" --limit 20; echo "exit=$?"
```

**Expected:**
- `Local bypasses (N)`: one line per entry, showing time, identity, hook, ref, sha and `"reason"` (initial setup ×2, e2e bypass test, cut release).
- `main: checking K commit(s)`:
  - `✔ <sha7> PR #<n> (1/1 approvals)` for the approved merges (8.4, 9.2, 11.2, 11.3)
  - `✖ <sha7> not from a merged pull request: chore: add vcs-protection (…)` for the bootstrap commit
  - `✖` for the `allowed now` commit from 11.2
- `release/1.0: checking …`: its commits are `main` commits, so they're matched against PRs into `release/1.0`. Expect `✖` lines here. This is correct: those commits weren't merged via PRs into that branch.
- `<P> problem(s) found.` and `exit=1`.

Reverted commits (Phase 8.2 and 10) don't appear, because they're no longer on the branches.

- [ ] passed

### 12.3 `audit` without a token

An empty `GH_CONFIG_DIR` makes `gh` look logged out for this one command:

```bash
GITHUB_TOKEN= GH_TOKEN= GH_CONFIG_DIR="$WORK/no-gh" vcs-protection audit; echo "exit=$?"
```

**PS:**

```powershell
$env:GH_CONFIG_DIR = "$env:WORK\no-gh"; $env:GITHUB_TOKEN = ""
vcs-protection audit; "exit=$LASTEXITCODE"
Remove-Item Env:GH_CONFIG_DIR
```

**Expected:** the local bypass list, then ``Skipping remote history audit: needs a GitHub remote and a token (GITHUB_TOKEN, GH_TOKEN or `gh auth login`).``, then `exit=1` (because bypasses exist).

- [ ] passed

---

## 13. Optional: run `ci-guard` locally

This checks the guard's PR logic from your machine. It only posts a commit status, so it's harmless. Open any PR into `main` (for example from `feature/chain`), then:

```bash
cd "$WORK/alice"
gh api repos/<you>/express-vcs-test/pulls/<n> \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify({pull_request:JSON.parse(s)})))" \
  > "$WORK/pr-event.json"
GITHUB_EVENT_NAME=pull_request GITHUB_EVENT_PATH="$WORK/pr-event.json" \
GITHUB_REPOSITORY=<you>/express-vcs-test vcs-protection ci-guard; echo "exit=$?"
```

**PS:**

```powershell
$env:GITHUB_EVENT_NAME="pull_request"
$env:GITHUB_EVENT_PATH="$env:WORK\pr-event.json"
$env:GITHUB_REPOSITORY="<you>/express-vcs-test"
vcs-protection ci-guard
```

**Expected:** `PR #<n>: 0/1 approvals (not enough to merge)` and `exit=0`. The PR shows a `vcs-protection/approvals` status posted by your own account.

Running it without the `GITHUB_*` variables prints `ci-guard must run inside GitHub Actions (…)` and `exit=1`.

Close the PR afterwards.

- [ ] passed / skipped

---

## 14. Cleanup and the publish checklist

### 14.1 Clean up the test environment

```bash
cd "$WORK/alice" && vcs-protection uninstall
cd "$WORK/bob" && vcs-protection uninstall
cd "$WORK/carol" && vcs-protection uninstall
vcs-protection uninstall --global
git config --global init.templateDir || echo "(unset)"
rm -rf ~/.vcs-protection
npm uninstall -g vcs-protection
# restore the init.templateDir saved in Phase 1, if the file is not empty:
[ -s "$WORK/templateDir.bak" ] && git config --global init.templateDir "$(cat "$WORK/templateDir.bak")"
```

**PS (last line):** `$t = Get-Content "$env:WORK\templateDir.bak"; if ($t) { git config --global init.templateDir $t }`

**Expected:**
- Each repo `uninstall` prints `✔ Removed hooks: …`.
- `uninstall --global` prints `✔ Removed the global git template.` and `init.templateDir` is `(unset)`.
- `init.templateDir` ends up as it was before the test.

Run the repo `uninstall`s **before** `npm uninstall -g`: hooks left behind by a removed CLI print `CLI not found` on every commit (6.4).

On GitHub:
- delete the `vcs-protection/rescue/*`, `feature/*` and `release/*` branches
- close the vcs-protection issues
- optionally delete `express-vcs-test` entirely

Re-run the app baseline from 3.3 once (`npm start` + `curl`). **Expected:** identical behavior.

- [ ] done

### 14.2 Record findings

For each unchecked box, note the step, the actual output, and your OS/shell. Fix the issues in `PKG`, then re-run from Phase 2 (`npm test`, `npm pack`, `npm i -g` (which re-runs the automatic setup), copy the new tarball into `.vcs-protection-dev/` through an approved PR).

### 14.3 Publish checklist

- [ ] All phases above passed (or have accepted notes)
- [ ] The package name is free: `npm view vcs-protection` returns 404. If it doesn't, rename it to a scoped `@<you>/vcs-protection`, and update `bin` usage and the `npx` line in `src/github/workflow.ts`.
- [ ] Version bumped: `npm version <patch|minor|major>`. The workflow pins this version.
- [ ] `npm publish --dry-run` looks right
- [ ] `npm publish`
- [ ] Fresh machine or shell: `npm i -g vcs-protection` → `vcs-protection --version`, and `git config --global init.templateDir` points at `~/.vcs-protection/git-template` (npm ≥ 12: `npm i -g --allow-scripts=vcs-protection vcs-protection`)
- [ ] In a real Node project: `npm i -D vcs-protection` (npm ≥ 12: plus `npm install-scripts approve vcs-protection`, and check that `allowScripts` now names `vcs-protection`), commit `package.json`, then in a fresh clone `npm ci` → `npx vcs-protection status` shows 6 × ✔
- [ ] In a real repo: `vcs-protection github setup` (**no patch**), then merge it through a PR. One direct `--no-verify` push gets reverted by the published guard.
- [ ] `vcs-protection doctor` shows all ✔ (the guard is no longer "out of date")

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| A legitimate PR merge is reverted as `direct-push` | GitHub's "commit → PR" association can lag a few seconds. Re-run the job. If it happens repeatedly, record it as a bug. |
| Guard run fails with `403 Resource not accessible by integration` | Workflow permissions aren't set to "Read and write" (3.2). |
| Guard fails at `npm i -g ./.vcs-protection-dev/...` | The tarball isn't committed on `main`, or the patch is missing. Run `node dev-patch-workflow.mjs .` |
| Hooks don't fire at all | Run `vcs-protection doctor`. Check `git config core.hooksPath`, and that `.git/hooks/reference-transaction` exists. |
| `npm install` didn't install any hooks | npm ≥ 12 without an `allowScripts` approval (look for `install scripts blocked`), `--ignore-scripts` (or `ignore-scripts=true` in an `.npmrc`), `CI` or `VCS_PROTECTION_SKIP_INSTALL` set, or not a git repo. Re-run with `--foreground-scripts` to see what the script says. |
| `status` / `doctor` show every hook as `outdated` in a project with the local dependency | You ran the **global** CLI; the hooks belong to the project's copy. Use `npx vcs-protection status`. |
| `CLI not found: branch protection is NOT active` after removing the package | The hooks outlived the CLI (`npm uninstall` runs no scripts). Reinstall, or remove the hooks with `vcs-protection uninstall` / by deleting the managed files in `.git/hooks`. |
| `npm i -g` left `init.templateDir` unchanged | Another template was already configured. `vcs-protection install --global --force` replaces it. |
| `protect` doesn't open a PR | No token found. Run `gh auth status`, or set `GITHUB_TOKEN`. |
| Every commit feels slow | Each blocked or protected-branch operation starts Node (about 150–200 ms). Commits on feature branches pay this once, for pre-commit. |
