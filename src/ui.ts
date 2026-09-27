/** One line of command output, as captured for the studio. */
export interface OutputLine {
  level: 'info' | 'warn' | 'error';
  text: string;
}

/** While set, output goes here instead of the terminal (see `withCapturedOutput`). */
let sink: OutputLine[] | null = null;

const useColor = () => !sink && !process.env.NO_COLOR && (process.stderr.isTTY || !!process.env.FORCE_COLOR);

const wrap = (open: number, close: number) => (s: string) => (useColor() ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const c = {
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
  bold: wrap(1, 22),
  dim: wrap(2, 22),
};

export const PREFIX = '[vcs-protection]';

export function info(msg: string): void {
  if (sink) sink.push({ level: 'info', text: msg });
  else process.stdout.write(`${msg}\n`);
}

export function warn(msg: string): void {
  if (sink) sink.push({ level: 'warn', text: msg });
  else process.stderr.write(`${c.yellow(PREFIX)} ${msg}\n`);
}

export function error(msg: string): void {
  if (sink) sink.push({ level: 'error', text: msg });
  else process.stderr.write(`${c.red(PREFIX)} ${msg}\n`);
}

/** A boxed, multi-line message written to stderr (used when a hook blocks something). */
export function blockBox(title: string, lines: string[]): void {
  if (sink) {
    sink.push({ level: 'error', text: `✖ ${title}` }, ...lines.map((l) => ({ level: 'error' as const, text: `  ${l}` })));
    return;
  }
  const body = lines.map((l) => `  ${l}`).join('\n');
  process.stderr.write(`\n${c.red(c.bold(`✖ ${PREFIX} ${title}`))}\n${body}\n\n`);
}

/**
 * Run `fn` with all `info`/`warn`/`error`/`blockBox` output collected instead of printed (no
 * colours), so the studio can show a command's messages exactly as the terminal would.
 * Not re-entrant: the studio runs one action at a time.
 */
export async function withCapturedOutput<T>(fn: () => T | Promise<T>): Promise<{ value?: T; error?: Error; output: OutputLine[] }> {
  const output: OutputLine[] = [];
  const previous = sink;
  sink = output;
  try {
    return { value: await fn(), output };
  } catch (err) {
    return { error: err as Error, output };
  } finally {
    sink = previous;
  }
}
