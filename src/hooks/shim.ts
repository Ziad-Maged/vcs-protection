export const MANAGED_MARKER = '# vcs-protection:managed';

export const HOOKS = [
  'reference-transaction',
  'pre-commit',
  'pre-merge-commit',
  'pre-push',
  'post-checkout',
  'post-merge',
] as const;

export type HookName = (typeof HOOKS)[number];

/** Exit code of `vcs-protection hook` that means "block this operation". Any other non-zero code is a crash. */
export const BLOCK_EXIT = 3;

/** Hooks that receive data on stdin that must be forwarded to both our handler and a chained hook. */
const STDIN_HOOKS: ReadonlySet<HookName> = new Set(['reference-transaction', 'pre-push']);
/** Hooks whose outcome cannot block anything; our part never fails them. */
const ADVISORY_HOOKS: ReadonlySet<HookName> = new Set(['post-checkout', 'post-merge']);

export interface ShimOptions {
  hook: HookName;
  nodePath: string;
  cliPath: string;
  failMode: 'open' | 'closed';
  /** The shared remote (`config.remote`) whose default branch may hold the config. */
  remote?: string;
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const posix = (p: string) => p.replace(/\\/g, '/');

/**
 * POSIX sh script installed as a git hook. Git for Windows runs these through its bundled sh.
 *
 * - Skips all work in repositories that have no vcs-protection config (so a global template is cheap).
 * - For reference-transaction, only starts Node for the `prepared` state when a local branch
 *   (refs/heads/*) is involved, so `git fetch` never pays the Node startup cost.
 * - Chains a pre-existing hook that was renamed to `<hook>.local` at install time.
 * - The CLI exits BLOCK_EXIT to block. Any other failure (crash, old Node, broken install) follows
 *   `failMode`, so `open` never locks people out because of a bug.
 */
export function renderShim(o: ShimOptions): string {
  const stdin = STDIN_HOOKS.has(o.hook);
  // Remote names can't contain shell metacharacters that matter here, but stay safe anyway.
  const remote = /^[A-Za-z0-9._-]+$/.test(o.remote ?? '') ? o.remote! : 'origin';
  const advisory = ADVISORY_HOOKS.has(o.hook);

  const gate =
    o.hook === 'reference-transaction'
      ? `vcsp_should_run() {
  [ "$1" = "prepared" ] || return 1
  case "$VCSP_INPUT" in *" refs/heads/"*) ;; *) return 1 ;; esac
  vcsp_relevant
}`
      : `vcsp_should_run() {
  vcsp_relevant
}`;

  const invokeOurs = stdin
    ? `printf '%s\\n' "$VCSP_INPUT" | vcsp_run "$@"`
    : `vcsp_run "$@"`;
  const invokeLocal = stdin
    ? `printf '%s\\n' "$VCSP_INPUT" | "$VCSP_LOCAL" "$@"`
    : `"$VCSP_LOCAL" "$@"`;

  return `#!/bin/sh
${MANAGED_MARKER}
# Installed by vcs-protection. Do not edit; run \`vcs-protection uninstall\` to remove.
VCSP_HOOK=${sq(o.hook)}
VCSP_NODE=${sq(posix(o.nodePath))}
VCSP_CLI=${sq(posix(o.cliPath))}
VCSP_FAIL=${sq(o.failMode)}
VCSP_LOCAL="$(dirname "$0")/${o.hook}.local"
${stdin ? 'VCSP_INPUT=$(cat)\n' : ''}
vcsp_relevant() {
  vcsp_top=$(git rev-parse --show-toplevel 2>/dev/null) || return 1
  [ -f "$vcsp_top/.vcs-protection.json" ] && return 0
  for vcsp_ref in refs/remotes/${remote}/HEAD refs/remotes/${remote}/main refs/remotes/${remote}/master; do
    git cat-file -e "$vcsp_ref:.vcs-protection.json" 2>/dev/null && return 0
  done
  return 1
}

${gate}

vcsp_run() {
  if [ -f "$VCSP_NODE" ] && [ -f "$VCSP_CLI" ]; then
    "$VCSP_NODE" "$VCSP_CLI" hook "$VCSP_HOOK" "$@"
  elif command -v vcs-protection >/dev/null 2>&1; then
    vcs-protection hook "$VCSP_HOOK" "$@"
  else
    echo "[vcs-protection] CLI not found: branch protection is NOT active. Reinstall: npm i -g vcs-protection && vcs-protection init" >&2
    [ "$VCSP_FAIL" = "closed" ] && return ${BLOCK_EXIT}
    return 0
  fi
}

if vcsp_should_run "$@"; then
${
  advisory
    ? `  ${invokeOurs} || true`
    : `  ${invokeOurs}
  vcsp_code=$?
  if [ "$vcsp_code" -eq ${BLOCK_EXIT} ]; then
    exit 1
  elif [ "$vcsp_code" -ne 0 ]; then
    echo "[vcs-protection] the $VCSP_HOOK check failed (exit $vcsp_code); failMode is $VCSP_FAIL." >&2
    [ "$VCSP_FAIL" = "closed" ] && exit 1
  fi`
}
fi

if [ -f "$VCSP_LOCAL" ]; then
  ${invokeLocal} || exit $?
fi
exit 0
`;
}
