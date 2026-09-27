import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { readAuditLog } from '../audit/log.js';
import { doctorChecks } from '../commands/status.js';
import { repoRoot } from '../git/repo.js';
import { withCapturedOutput } from '../ui.js';
import { ACTIONS, type ActionName } from './actions.js';
import { notFoundPage, renderPage } from './page.js';
import { studioState } from './state.js';

export const TOKEN_HEADER = 'x-studio-token';
const MAX_BODY = 1024 * 1024;

export const newToken = () => randomBytes(24).toString('base64url');

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const sameToken = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function securityHeaders(res: ServerResponse, nonce?: string): void {
  res.setHeader(
    'Content-Security-Policy',
    nonce
      ? `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      : "default-src 'none'; frame-ancestors 'none'",
  );
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  securityHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Send JSON (Content-Type: application/json).');
  }
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) throw new HttpError(413, 'Request body too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

export interface StudioServer {
  server: Server;
  token: string;
  /** http://127.0.0.1:<port>/?t=<token> once listening. */
  url(): string;
}

/**
 * The studio's HTTP server: the page, a read API and one POST endpoint per action.
 *
 * It runs git and GitHub operations for whoever can reach it, so it only answers the page it
 * served itself: loopback only (the caller binds 127.0.0.1), a per-session token on every API
 * call, a Host check against DNS rebinding, an Origin check against cross-site POSTs, JSON-only
 * bodies, and no CORS.
 */
export function createStudioServer(opts: { token?: string } = {}): StudioServer {
  const token = opts.token ?? newToken();
  let busy = false;

  const port = () => (server.address() as AddressInfo | null)?.port;
  const allowedHosts = () => [`127.0.0.1:${port()}`, `localhost:${port()}`];

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!allowedHosts().includes(req.headers.host ?? '')) throw new HttpError(403, 'Unexpected Host header.');

      if (req.method === 'GET' && url.pathname === '/') {
        const nonce = randomBytes(16).toString('base64');
        const ok = sameToken(url.searchParams.get('t') ?? '', token);
        securityHeaders(res, ok ? nonce : undefined);
        res.writeHead(ok ? 200 : 403, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(ok ? renderPage({ token, nonce }) : notFoundPage());
        return;
      }

      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found.');
      if (!sameToken(String(req.headers[TOKEN_HEADER] ?? ''), token)) throw new HttpError(403, 'Missing or wrong studio token.');

      if (req.method === 'GET') {
        if (url.pathname === '/api/state') return sendJson(res, 200, studioState());
        if (url.pathname === '/api/doctor') {
          if (!repoRoot()) return sendJson(res, 200, { checks: [] });
          const { value, error } = await withCapturedOutput(() => doctorChecks());
          return sendJson(res, 200, error ? { checks: [], error: error.message } : { checks: value });
        }
        if (url.pathname === '/api/bypasses') return sendJson(res, 200, { entries: repoRoot() ? readAuditLog() : [] });
        throw new HttpError(404, 'Not found.');
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/actions/')) {
        const origin = req.headers.origin;
        if (origin && !allowedHosts().some((h) => origin === `http://${h}`)) throw new HttpError(403, 'Cross-origin request refused.');
        const name = url.pathname.slice('/api/actions/'.length) as ActionName;
        const action = ACTIONS[name];
        if (!Object.hasOwn(ACTIONS, name) || !action) throw new HttpError(404, `Unknown action '${name}'.`);
        const body = await readJson(req);
        const parsed = (action.schema as z.ZodTypeAny).safeParse(body);
        if (!parsed.success) {
          throw new HttpError(400, 'Invalid arguments.', {
            issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          });
        }
        if (busy) throw new HttpError(409, 'Another action is running; wait for it to finish.');
        busy = true;
        try {
          const run = action.run as (a: unknown) => unknown;
          const { value, error, output } = await withCapturedOutput(() => run(parsed.data));
          const exitCode = error ? 1 : typeof value === 'number' ? value : 0;
          return sendJson(res, 200, {
            ok: !error && exitCode === 0,
            exitCode,
            output,
            ...(error ? { error: error.message } : {}),
            ...(value !== undefined && typeof value === 'object' ? { result: value } : {}),
          });
        } finally {
          busy = false;
        }
      }
      throw new HttpError(405, 'Method not allowed.');
    } catch (err) {
      // Answering before the body was read: discard the rest, and don't reuse this connection
      // (a keep-alive client would otherwise send its next request into the unread upload).
      if (!req.complete) res.setHeader('Connection', 'close');
      req.resume();
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, ...err.extra });
      return sendJson(res, 500, { error: (err as Error).message });
    }
  });

  return {
    server,
    token,
    url: () => `http://127.0.0.1:${port()}/?t=${token}`,
  };
}
