import { spawn } from 'node:child_process';
import { createStudioServer } from '../studio/server.js';
import { c, info, warn } from '../ui.js';

export interface StudioOptions {
  port?: string;
  /** commander maps --no-open to open: false */
  open?: boolean;
}

/** Open `url` in the default browser; failures only matter to the user, who has the printed link. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args as string[], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => warn('Could not open a browser; open the link above yourself.'));
    child.unref();
  } catch {
    warn('Could not open a browser; open the link above yourself.');
  }
}

/**
 * `vcs-protection studio`: serve the web UI on 127.0.0.1 until Ctrl+C. The printed link carries
 * the session token; the studio accepts no request without it.
 */
export async function studio(opts: StudioOptions): Promise<number> {
  const port = opts.port === undefined ? 0 : Number(opts.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid --port: '${opts.port}'.`);

  const studioServer = createStudioServer();
  const { server } = studioServer;
  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) =>
      reject(err.code === 'EADDRINUSE' ? new Error(`Port ${port} is already in use; pick another with --port, or omit it for a free one.`) : err),
    );
    server.listen(port, '127.0.0.1', resolve);
  });

  const url = studioServer.url();
  info(`${c.green('✔')} Studio running at ${c.cyan(url)}`);
  info(c.dim('  Only this computer can reach it, and only with this link. Press Ctrl+C to stop.'));
  if (opts.open !== false) openBrowser(url);

  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      server.close(() => resolve());
      server.closeAllConnections();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  info('Studio stopped.');
  return 0;
}
