const useColor = () => !process.env.NO_COLOR && (process.stderr.isTTY || !!process.env.FORCE_COLOR);

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
  process.stdout.write(`${msg}\n`);
}

export function warn(msg: string): void {
  process.stderr.write(`${c.yellow(PREFIX)} ${msg}\n`);
}

export function error(msg: string): void {
  process.stderr.write(`${c.red(PREFIX)} ${msg}\n`);
}

/** A boxed, multi-line message written to stderr (used when a hook blocks something). */
export function blockBox(title: string, lines: string[]): void {
  const body = lines.map((l) => `  ${l}`).join('\n');
  process.stderr.write(`\n${c.red(c.bold(`✖ ${PREFIX} ${title}`))}\n${body}\n\n`);
}
