import { Command } from 'commander';
import { readStdin } from './hooks/context.js';
import { runHook } from './hooks/handlers.js';
import { HOOKS, type HookName } from './hooks/shim.js';
import { error } from './ui.js';
import { VERSION } from './version.js';

const STDIN_HOOKS = new Set<HookName>(['reference-transaction', 'pre-push']);

function action<A extends unknown[]>(fn: (...args: A) => unknown) {
  return async (...args: A) => {
    try {
      const code = await fn(...args);
      if (typeof code === 'number') process.exitCode = code;
    } catch (err) {
      error((err as Error).message);
      process.exitCode = 1;
    }
  };
}

const program = new Command()
  .name('vcs-protection')
  .description('Branch protection for local git clones, backed by a GitHub Actions guard.')
  .version(VERSION);

program
  .command('init')
  .description('create the config (if missing) and install the git hooks in this clone')
  .option('-b, --branches <list>', 'comma-separated branches/globs to protect (skips the prompt)')
  .option('-a, --approvals <n>', 'required approvals per pull request (skips the prompt)')
  .option('--github', 'also write the GitHub Actions guard workflow')
  .action(action(async (opts) => (await import('./commands/init.js')).init(opts)));

program
  .command('protect <pattern>')
  .description('protect a branch (or glob); the change is committed on a PR branch')
  .option('-a, --approvals <n>', 'required approvals')
  .option('--allow-deletion', 'allow deleting the branch on the remote')
  .option('--no-commit', 'only edit the config file')
  .option('--no-push', 'commit but do not push or open a pull request')
  .action(action(async (pattern, opts) => (await import('./commands/rules.js')).protect(pattern, opts)));

program
  .command('unprotect <pattern>')
  .description('stop protecting a branch pattern; takes effect once the PR is merged')
  .option('--no-commit', 'only edit the config file')
  .option('--no-push', 'commit but do not push or open a pull request')
  .action(action(async (pattern, opts) => (await import('./commands/rules.js')).unprotect(pattern, opts)));

program
  .command('list')
  .description('show the effective protection rules')
  .option('--json', 'machine-readable output')
  .action(action(async (opts) => (await import('./commands/status.js')).list(opts)));

program
  .command('status')
  .description('show rules, hook installation state and local bypass count')
  .action(action(async () => (await import('./commands/status.js')).status()));

program
  .command('doctor')
  .description('verify the installation; --fix repairs missing or stale hooks')
  .option('--fix', 'reinstall missing/outdated hooks')
  .action(action(async (opts) => (await import('./commands/status.js')).doctor(opts)));

const github = program.command('github').description('GitHub integration');
github
  .command('setup')
  .description('write the GitHub Actions guard workflow for this repository')
  .option('--pin <version>', 'vcs-protection version the workflow runs')
  .action(action(async (opts) => (await import('./commands/github.js')).githubSetup(opts)));

program
  .command('audit')
  .description('list local bypasses and protected-branch commits that did not come from an approved PR')
  .option('--since <date>', 'only commits after this date (git --since syntax)')
  .option('--limit <n>', 'max commits per branch', '50')
  .action(action(async (opts) => (await import('./commands/github.js')).audit(opts)));

program
  .command('install')
  .description('install hooks for every future clone via git init.templateDir')
  .requiredOption('--global', 'install into the global git template')
  .option('--force', 'replace an existing init.templateDir')
  .action(action(async (opts) => (await import('./commands/install.js')).installGlobal(opts)));

program
  .command('uninstall')
  .description('remove the hooks from this clone (restores chained hooks)')
  .option('--global', 'remove the global git template instead')
  .action(action(async (opts) => (await import('./commands/install.js')).uninstall(opts)));

program
  .command('hook <name> [args...]', { hidden: true })
  .description('internal: invoked by the installed git hooks')
  .action(
    action(async (name: string, args: string[]) => {
      if (!(HOOKS as readonly string[]).includes(name)) throw new Error(`Unknown hook '${name}'.`);
      const hook = name as HookName;
      const input = STDIN_HOOKS.has(hook) ? await readStdin() : '';
      return runHook(hook, args, input);
    }),
  );

program
  .command('ci-guard', { hidden: true })
  .description('internal: run by the GitHub Actions guard workflow')
  .action(action(async () => (await import('./commands/ciGuard.js')).ciGuard()));

program
  .command('postinstall', { hidden: true })
  .description('internal: run by the npm postinstall script to set up hooks automatically')
  .action(action(async () => (await import('./commands/postinstall.js')).postinstall()));

await program.parseAsync(process.argv);
