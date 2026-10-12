/**
 * Code questions answered by Jev instead of read into the model's context: narrow a big Read to the part the request
 * needs, sweep a folder with one yes/no question, find code by describing it. Ported from BorisLeMeec/jev (MIT,
 * Boris Le Méec), keeping its measured gates. Pure: each host supplies listing, reading and the Jev call.
 */
import { choice, clip, noul, type Answers, type Questions } from './policy.ts'

/** What a host lends the code tools: list files under a folder, read one, ask Jev (null on any failure). */
export type CodeIO = {
  list: (dir: string) => Promise<string[]>
  read: (path: string) => Promise<string | undefined>
  ask: (state: unknown, questions: Questions) => Promise<Answers | null>
}

// --- locate: which run of lines in one file implements the goal ---

/** One request carries the file roughly twice (text and labels); jev measured 134 KB refused, 113 KB accepted. */
export const MAX_SECTION = 80_000
const MAX_CHUNKS = 200
const LOCATE = 'Which numbered chunk of `file.chunks` contains the part of this file that most directly implements ' +
  'what `goal` describes? Each chunk is a run of consecutive lines from the file at `file.path`.'

/** The line the goal points at and how peaked Jev's pick was; line 0 when the file has no single place. */
export async function locate(io: CodeIO, goal: string, path: string, text: string): Promise<{ line: number; conf: number } | null> {
  const lines = text.split('\n')
  const size = Math.max(10, Math.ceil(lines.length / MAX_CHUNKS))
  const chunks: Record<string, { start_line: number; text: string }> = {}
  const criteria: Record<string, string> = {}
  for (let start = 0, i = 0; start < lines.length; start += size, i++) {
    const end = Math.min(start + size, lines.length)
    chunks[`c${i}`] = { start_line: start + 1, text: lines.slice(start, end).join('\n') }
    criteria[`c${i}`] = `lines ${start + 1}-${end}`
  }
  if (Object.keys(chunks).length < 2) return { line: 1, conf: 1 }
  const a = await io.ask({ goal: clip(goal, 1500), file: { path, chunks } }, { where: choice(LOCATE, criteria) })
  const w = a?.where
  if (!w || w.type !== 'choice') return null
  return { line: chunks[w.choice]?.start_line ?? 0, conf: w.confidence }
}

// --- Read narrowing ---

export const NARROW_MIN_LINES = 400
export const NARROW_MIN_CONF = 0.6

/**
 * The window to read instead of the whole file, or null to read it all. Biased toward doing nothing: small files, files
 * too big for one request, reads the agent already windowed, no request to aim at, and a spread-out pick all pass.
 * jev measured: the pick sits a median 4 lines from the target, all within 60, and a correct pick scores 0.71 or more.
 */
export async function narrowRead(io: CodeIO, goal: string, path: string, text: string): Promise<{ offset: number; limit: number; line: number; conf: number; lines: number } | null> {
  const lines = text.split('\n').length
  if (lines < NARROW_MIN_LINES || text.length > MAX_SECTION || goal.trim().length < 12) return null
  const got = await locate(io, goal, path, text)
  if (!got || !got.line || got.conf < NARROW_MIN_CONF) return null
  const limit = Math.max(150, Math.floor(lines / 5))
  if (limit >= lines) return null
  const offset = Math.max(1, Math.min(got.line - Math.floor(limit / 2), lines - limit))
  return { offset, limit, line: got.line, conf: got.conf, lines }
}

export const narrowNote = (path: string, n: { offset: number; limit: number; line: number; conf: number; lines: number }): string =>
  `[ohmyjev] Narrowed this Read: ${path} is ${n.lines} lines, showing ${n.offset}-${n.offset + n.limit - 1} (the request points at line ` +
  `${n.line}, confidence ${n.conf.toFixed(2)}). Read it again with an explicit offset or limit to see any other part.`

/** The window of an already-read text, numbered like a Read, for hosts that can only rewrite the result. */
export const windowOf = (text: string, n: { offset: number; limit: number }): string =>
  text.split('\n').slice(n.offset - 1, n.offset - 1 + n.limit).map((l, i) => `${String(n.offset + i).padStart(6)}\t${l}`).join('\n')

// --- files worth judging ---

const SKIP_DIRS = /(^|\/)(\.git|node_modules|vendor|bower_components|build|dist|out|target|\.dart_tool|\.idea|\.vscode|__pycache__|\.venv|venv|\.tox|\.next|\.nuxt|\.cache|coverage|Pods|\.gradle|\.terraform)(\/|$)/
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tar|bz2|xz|7z|jar|mp4|mov|mp3|wav|ttf|otf|woff2?|eot|so|dylib|dll|exe|bin|class|pyc|o|a|lock|sum|min\.js|min\.css|pb\.go|g\.dart|freezed\.dart)$/i
/** Source files only: no dependencies, build output, binaries, lockfiles, minified or generated code. */
export const sourceFile = (path: string): boolean => !SKIP_DIRS.test(path) && !SKIP_EXT.test(path) && !/(^|\/)\.[^/]+$/.test(path) && !/(^|\/)testdata\//.test(path)

// --- the skeleton: a file reduced to its declarations, for screening ---

const DECL = /^\s*(package\b|import\b|from\s+\S+\s+import\b|(public|private|protected|internal|static|final|abstract|export|default|async|extern|pub)\s+|func\b|function\b|def\b|fn\b|sub\b|type\b|struct\b|interface\b|enum\b|trait\b|impl\b|protocol\b|extension\b|class\b|mixin\b|object\b|module\b|namespace\b|const\b|var\b|let\b|val\b|@\w+|(CREATE|ALTER)\s+(TABLE|INDEX|VIEW)\b|\w[\w<>[\]*\s,.]*\s+\w+\s*\([^)]*\)\s*(\{|=>|;|$))/
const ROUTE = /(HandleFunc|\.(get|post|put|patch|delete)\s*\(|@(Get|Post|Put|Patch|Delete|Request)Mapping|route\s*\(|path:\s*['"]|r\.(Get|Post|Handle))/i
const MARKUP = /(<form|<input|<select|<textarea|<button|<label|\baction=|\bname=|<h[1-4]\b|<title|\{\{\s*(define|template|block|if|range)\b|\{%\s*(block|for|if)\b|v-model=|ng-model=|formControlName=)/i

/** Declarations, routes and form markup, up to 40 lines; the first lines when a file declares little. */
export function skeleton(text: string, max = 40): string {
  const kept: string[] = []
  let leading = true
  const lines = text.split('\n')
  for (let i = 0; i < lines.length && kept.length < max; i++) {
    const line = lines[i]!
    const t = line.trim()
    if (!t) continue
    const comment = /^(\/\/|#|\/\*|\*|--|<!--)/.test(t)
    if (leading && i < 12) {
      kept.push(clip(t, 160))
      if (!comment && !DECL.test(line)) leading = false
    } else if (DECL.test(line) || ROUTE.test(line) || MARKUP.test(line)) kept.push(clip(t, 160))
  }
  if (kept.length < 6) for (const t of lines.map(l => l.trim()).filter(Boolean).slice(0, max / 2)) if (!kept.includes(clip(t, 160))) kept.push(clip(t, 160))
  return kept.join('\n')
}

/** Runs `fn` over `items`, at most `n` at a time. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }))
  return out
}

// --- ask: one yes/no question per file in a folder ---

const ASK = 'Answer `question` about the source file at `file.path`, using only the code in `file.content`. Answer yes only ' +
  'if the code itself shows it; do not assume behaviour that is not visible here.'
export const SWEEP_MAX_FILES = 300

/** Every file that answers yes (0.5, jev's measured split: true files score 0.92-0.99, false 0.02-0.13), with its line. */
export async function sweep(io: CodeIO, question: string, files: string[]): Promise<{ files: number; yes: Array<{ path: string; p: number; line?: number }>; skipped?: string }> {
  const src = files.filter(sourceFile)
  if (src.length > SWEEP_MAX_FILES) return { files: src.length, yes: [], skipped: `${src.length} files is over the ${SWEEP_MAX_FILES}-file limit; name a narrower folder` }
  const scored = await pool(src, 8, async path => {
    const text = await io.read(path)
    if (!text) return null
    const a = await io.ask({ question: clip(question, 1500), file: { path, content: text.slice(0, MAX_SECTION) } }, { answer: noul(ASK) })
    const p = a?.answer?.type === 'noul' ? a.answer.noul : 0
    if (p < 0.5) return null
    const at = text.length <= MAX_SECTION ? await locate(io, question, path, text) : null
    return { path, p, ...(at && at.conf >= 0.5 ? { line: at.line } : {}) }
  })
  return { files: src.length, yes: scored.filter(x => x !== null).sort((a, b) => b.p - a.p) }
}

// --- find: locate code by describing it ---

const SCREEN = 'Is the file at `file.path` one of the places where what `goal` describes is actually carried out? Judge ' +
  'only from `file.skeleton`, a reduction of the file to its declarations, by what this file\'s own code does, not by ' +
  'whether it uses the same words as `goal`. The codebase may name the concept differently, in another natural ' +
  'language, or with an internal term.'
const VERIFY = SCREEN.replace('only from `file.skeleton`, a reduction of the file to its declarations,', 'from `file.content`, the file\'s full source,')
const PERFORMS = 'This file\'s own code performs it: it defines the handler, endpoint, form, screen, query or logic that carries ' +
  'it out. Removing this file would break it.'
const SUPPORTS = 'Everything else, including files that only support it (shared components, styling, helpers, configuration, ' +
  'dependency manifests) and files that merely call it or link to it.'
export const FIND_MAX_FILES = 800

/** Screen every file's skeleton, re-check the top 8 in full, find the line in the top 3; files at 0.6 or more, best 10. */
export async function find(io: CodeIO, goal: string, files: string[]): Promise<{ files: number; hits: Array<{ path: string; p: number; line?: number; verified: boolean }>; skipped?: string }> {
  const src = files.filter(sourceFile)
  if (src.length > FIND_MAX_FILES) return { files: src.length, hits: [], skipped: `${src.length} files is over the ${FIND_MAX_FILES}-file limit; name a narrower folder` }
  const g = clip(goal, 1500)
  const texts = new Map<string, string>()
  const screened = await pool(src, 8, async path => {
    const text = await io.read(path)
    if (!text) return null
    texts.set(path, text)
    const a = await io.ask({ goal: g, file: { path, skeleton: skeleton(text) } }, { match: noul(SCREEN, PERFORMS, SUPPORTS) })
    return a?.match?.type === 'noul' ? { path, p: a.match.noul, verified: false } : null
  })
  const hits: Array<{ path: string; p: number; line?: number; verified: boolean }> = screened.filter(h => h !== null).sort((a, b) => b.p - a.p)
  await pool(hits.slice(0, 8), 8, async h => {
    const a = await io.ask({ goal: g, file: { path: h.path, content: (texts.get(h.path) ?? '').slice(0, MAX_SECTION) } }, { match: noul(VERIFY, PERFORMS, SUPPORTS) })
    if (a?.match?.type === 'noul') Object.assign(h, { p: a.match.noul, verified: true })
  })
  hits.sort((a, b) => b.p - a.p)
  const kept = hits.filter(h => h.p >= 0.6).slice(0, 10)
  await pool(kept.slice(0, 3), 3, async h => {
    const text = texts.get(h.path) ?? ''
    const at = text.length <= MAX_SECTION ? await locate(io, goal, h.path, text) : null
    if (at && at.conf >= 0.5) h.line = at.line
  })
  return { files: src.length, hits: kept }
}

export const FIND_DESCRIPTION =
  'Find code by describing what it does, even when the codebase names it differently ("where is the register flow" ' +
  'finds a signup handler). Jev reads the files, not you: it screens every source file, re-checks the best in full and ' +
  'returns the files that carry it out, with the line. "No match" is a real answer. Use it before grepping for a concept.'
export const FIND_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string', description: 'What the code does, in plain words' },
    path: { type: 'string', description: 'Folder to search, inside the repo; default the repo root' },
  },
  required: ['goal'],
} as const
