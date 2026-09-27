import { z } from 'zod';
import { auditReport, githubSetup } from '../commands/github.js';
import { init } from '../commands/init.js';
import { installGlobal, uninstall } from '../commands/install.js';
import { protect, unprotect, updateSettings, type RuleChangeOptions, type SettingsPatch } from '../commands/rules.js';
import { doctor } from '../commands/status.js';
import { loadConfig } from '../config/load.js';

/**
 * Everything the studio can do. Each action calls the same function as the matching CLI
 * command; the server runs it with the output captured, one action at a time.
 */

/** How a rules/settings change is shared: open a PR (default), commit only, or edit the file only. */
const share = z.enum(['pr', 'commit', 'file']).default('pr');
const shareOpts = (s: 'pr' | 'commit' | 'file'): RuleChangeOptions => ({ commit: s !== 'file', push: s === 'pr' });
const pattern = z.string().trim().min(1).max(200);
const approvals = z.number().int().min(0).max(100);

export interface ActionDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  /** The CLI command it corresponds to (shown in the UI and the docs). */
  cli: string;
  /** Validates the JSON arguments sent by the page. */
  schema: S;
  run(args: z.infer<S>): Promise<unknown> | unknown;
}

const def = <S extends z.ZodTypeAny>(d: ActionDef<S>) => d;

export const ACTIONS = {
  init: def({
    cli: 'vcs-protection init -b <branches> -a <n> [--github]',
    schema: z.object({ branches: z.string().trim().min(1).max(500), approvals, github: z.boolean().default(false) }),
    run: (a) => init({ branches: a.branches, approvals: String(a.approvals), github: a.github }),
  }),
  installHooks: def({
    cli: 'vcs-protection init',
    schema: z.object({}),
    run: () => {
      // With rules in place `init` only (re)installs the hooks; without, it would create a
      // config, which is the `init` action's job.
      if (!loadConfig()) throw new Error('No rules yet: initialize the repository first.');
      return init({});
    },
  }),
  repairHooks: def({ cli: 'vcs-protection doctor --fix', schema: z.object({}), run: () => doctor({ fix: true }) }),
  uninstallHooks: def({ cli: 'vcs-protection uninstall', schema: z.object({}), run: () => uninstall({}) }),
  protect: def({
    cli: 'vcs-protection protect <pattern> [-a <n>] [--allow-deletion] [--no-commit|--no-push]',
    schema: z.object({ pattern, approvals: approvals.optional(), allowDeletion: z.boolean().optional(), share }),
    run: (a) =>
      protect(a.pattern, {
        approvals: a.approvals === undefined ? undefined : String(a.approvals),
        allowDeletion: a.allowDeletion,
        ...shareOpts(a.share),
      }),
  }),
  unprotect: def({
    cli: 'vcs-protection unprotect <pattern> [--no-commit|--no-push]',
    schema: z.object({ pattern, share }),
    run: (a) => unprotect(a.pattern, shareOpts(a.share)),
  }),
  updateSettings: def({
    cli: 'edit .vcs-protection.json, `github setup`, then a PR',
    // The shape is checked here; the values by the config schema when the result is parsed.
    schema: z.object({
      patch: z
        .object({
          github: z.record(z.string(), z.unknown()).optional(),
          bypass: z.object({ allowed: z.boolean() }).partial().optional(),
          failMode: z.enum(['open', 'closed']).optional(),
        })
        .strict(),
      share,
    }),
    run: (a) => updateSettings(a.patch as SettingsPatch, shareOpts(a.share)),
  }),
  githubSetup: def({
    cli: 'vcs-protection github setup [--pin <version>]',
    schema: z.object({ pin: z.string().trim().max(50).optional() }),
    run: (a) => githubSetup({ pin: a.pin || undefined }),
  }),
  audit: def({
    cli: 'vcs-protection audit [--since <date>] [--limit <n>]',
    schema: z.object({ since: z.string().trim().max(100).optional(), limit: z.number().int().min(1).max(1000).optional() }),
    run: (a) => auditReport({ since: a.since || undefined, limit: a.limit === undefined ? undefined : String(a.limit) }),
  }),
  installGlobal: def({
    cli: 'vcs-protection install --global [--force]',
    schema: z.object({ force: z.boolean().default(false) }),
    run: (a) => installGlobal({ force: a.force }),
  }),
  uninstallGlobal: def({ cli: 'vcs-protection uninstall --global', schema: z.object({}), run: () => uninstall({ global: true }) }),
} satisfies Record<string, ActionDef>;

export type ActionName = keyof typeof ACTIONS;
