import { z } from 'zod';

export const CONFIG_FILE = '.vcs-protection.json';

export const branchRuleSchema = z.object({
  /** Branch name or glob (picomatch syntax, e.g. `release/*`). */
  pattern: z.string().min(1),
  /** Approvals (from someone other than the PR author) required for a PR merge to be kept. */
  requiredApprovals: z.number().int().min(0).default(1),
  /** Whether the branch may be deleted on the remote. */
  allowDeletion: z.boolean().default(false),
});

export const CHECK_CONCLUSIONS = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'] as const;

const POISON_PILL_DEFAULTS = {
  enabled: false,
  workflows: [] as string[],
  checks: [] as string[],
  conclusions: ['failure', 'timed_out'] as (typeof CHECK_CONCLUSIONS)[number][],
};

export const poisonPillSchema = z
  .object({
    /** Revert a merge when a critical workflow fails on it after it landed on a protected branch. */
    enabled: z.boolean().default(false),
    /** `name:` of each critical workflow; the guard wakes up when one of them completes (workflow_run). */
    workflows: z.array(z.string().min(1)).default([]),
    /** Check-run (job) names that count as critical. Empty: every check run of the completed workflow. */
    checks: z.array(z.string().min(1)).default([]),
    /** Check-run conclusions that count as a breach. */
    conclusions: z.array(z.enum(CHECK_CONCLUSIONS)).min(1).default(['failure', 'timed_out']),
  })
  .superRefine((p, ctx) => {
    if (p.enabled && p.workflows.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['workflows'], message: 'list at least one workflow name when the poison pill is enabled' });
    }
  });

export const configSchema = z.object({
  $schema: z.string().optional(),
  version: z.literal(1),
  /** Remote that represents the team's shared repository. */
  remote: z.string().min(1).default('origin'),
  protected: z.array(branchRuleSchema).default([]),
  bypass: z
    .object({
      /** Allow `VCS_PROTECTION_BYPASS=<reason>` to let a single command through locally. */
      allowed: z.boolean().default(true),
    })
    .default({ allowed: true }),
  github: z
    .object({
      /** What the Actions guard does on a violation: revert it, or only report it in an issue. */
      enforcement: z.enum(['revert', 'report']).default('revert'),
      rescueBranchPrefix: z.string().min(1).default('vcs-protection/rescue/'),
      /** GitHub logins whose direct pushes the Actions guard allows (e.g. release managers). */
      bypassUsers: z.array(z.string()).default([]),
      /** Post-merge check: revert commits that break critical CI workflows. */
      poisonPill: poisonPillSchema.default(POISON_PILL_DEFAULTS),
    })
    .default({
      enforcement: 'revert',
      rescueBranchPrefix: 'vcs-protection/rescue/',
      bypassUsers: [],
      poisonPill: POISON_PILL_DEFAULTS,
    }),
  /** What hooks do if the CLI itself fails: `open` warns and allows, `closed` blocks. */
  failMode: z.enum(['open', 'closed']).default('open'),
});

export type BranchRule = z.infer<typeof branchRuleSchema>;
export type PoisonPill = z.infer<typeof poisonPillSchema>;
export type Config = z.infer<typeof configSchema>;

export function parseConfig(raw: string, source: string): Config {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${source}: invalid JSON (${(err as Error).message})`);
  }
  const res = configSchema.safeParse(json);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`${source}: invalid configuration\n${issues}`);
  }
  return res.data;
}

export function defaultConfig(branches: string[], approvals = 1): Config {
  return configSchema.parse({
    version: 1,
    protected: branches.map((pattern) => ({ pattern, requiredApprovals: approvals })),
  });
}

export function serializeConfig(config: Config): string {
  return JSON.stringify(config, null, 2) + '\n';
}
