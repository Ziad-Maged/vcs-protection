import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ACTIONS } from '../../src/studio/actions.js';
import { notFoundPage, renderPage } from '../../src/studio/page.js';
import { createStudioServer } from '../../src/studio/server.js';
import { info, warn, withCapturedOutput } from '../../src/ui.js';

describe('withCapturedOutput', () => {
  it('collects output and restores normal printing, even after a throw', async () => {
    const res = await withCapturedOutput(() => {
      info('hello');
      warn('careful');
      throw new Error('boom');
    });
    expect(res.output).toEqual([
      { level: 'info', text: 'hello' },
      { level: 'warn', text: 'careful' },
    ]);
    expect(res.error?.message).toBe('boom');
    const outer = await withCapturedOutput(() => 42);
    expect(outer).toEqual({ value: 42, output: [] });
  });
});

describe('renderPage', () => {
  it('puts the token only inside the nonce-tagged script, never in a URL or attribute', () => {
    const token = 'TOKEN_abc123';
    const html = renderPage({ token, nonce: 'NONCE' });
    expect(html.split(token)).toHaveLength(2);
    expect(html).toContain(`})("${token}");</script>`);
    expect(html).toContain('<script nonce="NONCE">');
    expect(html).toContain('<style nonce="NONCE">');
    expect(html).not.toMatch(/\son[a-z]+="/); // no inline event handlers (CSP)
    expect(notFoundPage()).not.toContain('<script');
  });
});

describe('studio server', () => {
  const started: ReturnType<typeof createStudioServer>[] = [];
  afterEach(() => {
    for (const s of started.splice(0)) s.server.close();
    delete (ACTIONS as Record<string, unknown>).slowTest;
  });

  it('runs one action at a time', async () => {
    (ACTIONS as Record<string, unknown>).slowTest = {
      cli: '-',
      schema: z.object({}),
      run: () => new Promise((r) => setTimeout(() => r(undefined), 300)),
    };
    const studio = createStudioServer({ token: 't' });
    started.push(studio);
    await new Promise<void>((r) => studio.server.listen(0, '127.0.0.1', r));
    const port = (studio.server.address() as AddressInfo).port;
    const post = () =>
      fetch(`http://127.0.0.1:${port}/api/actions/slowTest`, {
        method: 'POST',
        headers: { 'X-Studio-Token': 't', 'Content-Type': 'application/json' },
        body: '{}',
      });
    const first = post();
    await new Promise((r) => setTimeout(r, 50));
    const second = await post();
    expect(second.status).toBe(409);
    expect((await first).status).toBe(200);
    expect((await (await post()).json()).ok).toBe(true); // free again afterwards
  });
});
