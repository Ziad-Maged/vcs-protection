// npm `postinstall` entry. Sets up the git hooks automatically (see `vcs-protection postinstall`).
// Kept dependency-free and always exits 0: a hook setup problem must never fail `npm install`.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const skip = (process.env.VCS_PROTECTION_SKIP_INSTALL ?? '').trim().toLowerCase();
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

// dist/ is missing in a fresh checkout of this repository (it is built, not committed).
if (!['', '0', 'false'].includes(skip) || !existsSync(cli)) process.exit(0);

try {
  spawnSync(process.execPath, [cli, 'postinstall'], { stdio: 'inherit', windowsHide: true });
} catch {
  // ignore: see above
}
process.exit(0);
