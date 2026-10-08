/**
 * ohmyjev decision logic: config, Jev questions, judges, paths, status. No `$` and no I/O here, so tests table-drive
 * it. Rubrics: github.com/disler/ten-levels-of-jev.
 */

// --- config: mirrors plugin.json userConfig (the engine fills defaults; DEFAULTS serves tests) ---

export const DEFAULTS = {
  apiKey: '',
  jevModel: 'jev-1.13.0',
  bashGate: true,
  writeGate: true,
  injectionScreen: true,
  doneCheck: true,
  bashIrreversible: 0.6,
  bashDestructive: 0.7,
  writeSecret: 0.7,
  writeSecretsKind: 0.8,
  injection: 0.7,
  doneClaimed: 0.7,
  doneVerifiedMax: 0.3,
  doneAsksUserMax: 0.5,
  allowPaths: '~/.claude;$TMPDIR;/tmp',
}

export type Config = typeof DEFAULTS

export const readConfig = (options: Readonly<Record<string, unknown>>): Config => ({ ...DEFAULTS, ...options }) as Config

export const splitList = (s: string): string[] => s.split(';').map(x => x.trim()).filter(Boolean)
