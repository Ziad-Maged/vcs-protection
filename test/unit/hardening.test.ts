import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sameText } from '../../src/commands/shared.js';
import { dependentProject } from '../../src/commands/postinstall.js';
import { parseConfig } from '../../src/config/schema.js';
import { remoteKey } from '../../src/hooks/handlers.js';
import { sameToken } from '../../src/studio/server.js';

describe('sameToken', () => {
  it('compares tokens without throwing on non-ASCII input', () => {
    const token = 'a'.repeat(32);
    expect(sameToken(token, token)).toBe(true);
    expect(sameToken('é'.repeat(32), token)).toBe(false);
    expect(sameToken('', token)).toBe(false);
  });
});

describe('sameText', () => {
  it('ignores CRLF vs LF', () => {
    expect(sameText('a\r\nb\r\n', 'a\nb\n')).toBe(true);
    expect(sameText('a\nb', 'a\nc')).toBe(false);
  });
});

describe('dependentProject', () => {
  it('returns the filesystem root, not a bare drive, for a top-level node_modules', () => {
    const root = path.parse(process.cwd()).root;
    expect(dependentProject(path.join(root, 'node_modules', 'vcs-protection'))).toBe(root);
    expect(dependentProject(path.join(root, 'work', 'app', 'node_modules', 'vcs-protection'))).toBe(path.join(root, 'work', 'app'));
    expect(dependentProject(path.join(root, 'work', 'vcs-protection'))).toBeNull();
  });
});

describe('config remote name', () => {
  it('rejects names that git could read as an option or that need shell quoting', () => {
    expect(() => parseConfig('{"version":1,"remote":"--receive-pack=x"}', 'test')).toThrow(/remote/);
    expect(() => parseConfig('{"version":1,"remote":"a b"}', 'test')).toThrow(/remote/);
    expect(parseConfig('{"version":1,"remote":"upstream"}', 'test').remote).toBe('upstream');
  });
});

describe('remoteKey', () => {
  it('treats a path, a file:// URL and a .git suffix of the same local repository alike', () => {
    const repo = path.resolve('some', 'origin.git');
    const key = remoteKey(repo);
    expect(remoteKey(pathToFileURL(repo).href)).toBe(key);
    expect(remoteKey(path.relative(process.cwd(), repo))).toBe(key);
    expect(remoteKey(path.resolve('some', 'origin'))).toBe(key);
  });

  it('keeps GitHub and other network URLs as before', () => {
    expect(remoteKey('git@github.com:Owner/Repo.git')).toBe(remoteKey('https://github.com/owner/repo'));
    expect(remoteKey('ssh://git.example.com/team/app.git')).toBe('ssh://git.example.com/team/app');
    expect(remoteKey('host:team/app.git')).toBe('host:team/app');
  });
});
