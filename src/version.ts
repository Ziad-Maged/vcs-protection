import { createRequire } from 'node:module';

// Resolves to the package root's package.json both from src/ (tests) and dist/ (published build).
const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

export const VERSION: string = pkg.version;
