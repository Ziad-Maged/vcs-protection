import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { commonGitDir, userIdentity } from '../git/repo.js';

export interface AuditEntry {
  time: string;
  user: string;
  hook: string;
  kind: string;
  ref: string;
  oldSha: string;
  newSha: string;
  reason: string;
}

export function auditLogPath(cwd?: string): string {
  return path.join(commonGitDir(cwd), 'vcs-protection', 'audit.log');
}

export function recordBypass(entry: Omit<AuditEntry, 'time' | 'user'>, cwd?: string): void {
  const file = auditLogPath(cwd);
  mkdirSync(path.dirname(file), { recursive: true });
  const full: AuditEntry = { time: new Date().toISOString(), user: userIdentity(cwd), ...entry };
  appendFileSync(file, JSON.stringify(full) + '\n');
}

export function readAuditLog(cwd?: string): AuditEntry[] {
  const file = auditLogPath(cwd);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as AuditEntry];
      } catch {
        return [];
      }
    });
}
