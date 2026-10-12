/**
 * Writing-rule check: the agent's final reply checked against the writing rules in the project's instruction files
 * (CLAUDE.md, AGENTS.md), and rewritten once when it breaks one. Ported from vgeshel/prose-check (MIT): a model turns
 * the files into yes/no questions once per version of the files, then Jev asks them of each reply. Pure.
 */
import { noul, type Answers, type Questions } from './policy.ts'

export type Rule = { rule: string; question: string }
export const BREACH = 0.85 // prose-check's measured threshold
export const MIN_REPLY = 200
const MAX_RULES = 30

/** Fenced code is examples, not rules. */
const prose = (text: string): string => text.replace(/^ {0,3}(`{3,}|~{3,})[\s\S]*?^ {0,3}\1\s*$/gm, '')

export const extractionPrompt = (files: Array<{ path: string; text: string }>): string =>
  `The files below are instructions for a coding agent in one software project. Find every rule that governs how the agent writes prose addressed to the human it works with: its chat replies, status updates, and answers.
Return only rules that a reader can check by reading one finished reply, with no other context. Leave out rules about process (for example, which documents to read or which reviews to run), rules about code, and rules that need knowledge of the project or the conversation to check.
For each rule, write two fields:
- "rule": the rule as one self-contained sentence.
- "question": a yes/no question about the reply, which is available as \`response\`. A yes answer must mean that the reply breaks the rule. Ask about one condition only.
Split a compound rule into separate rules when its parts can be broken independently. Do not add rules that the files do not state.
Answer with a JSON array of {"rule": string, "question": string} objects and nothing else. Answer with [] when the files state no such rules.

${files.map(f => `<file path="${f.path}">\n${prose(f.text)}\n</file>`).join('\n\n')}`

/** The model's reply as rules; undefined when it is not a clean array of {rule, question}. */
export function parseRules(reply: string): Rule[] | undefined {
  const start = reply.indexOf('[')
  const end = reply.lastIndexOf(']')
  if (start < 0 || end < start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  const rules = parsed.filter((r): r is Rule => !!r && typeof r.rule === 'string' && typeof r.question === 'string' && !!r.rule.trim() && !!r.question.trim())
  return rules.length === parsed.length ? rules.slice(0, MAX_RULES).map(r => ({ rule: r.rule.trim(), question: r.question.trim() })) : undefined
}

export const ruleQuestions = (rules: Rule[]): Questions => Object.fromEntries(rules.map((r, i) => [`rule_${i}`, noul(r.question)]))

/** The rules the reply breaks, surest first. */
export const broken = (a: Answers, rules: Rule[]): Rule[] =>
  rules
    .map((r, i) => ({ r, p: a[`rule_${i}`]?.type === 'noul' ? (a[`rule_${i}`] as { noul: number }).noul : 0 }))
    .filter(x => x.p >= BREACH)
    .sort((a, b) => b.p - a.p)
    .map(x => x.r)

export const rewriteReason = (rules: Rule[]): string =>
  `Your last reply breaks ${rules.length === 1 ? 'a writing rule' : 'writing rules'} in this project's instructions:\n` +
  rules.map(r => `- ${r.rule}`).join('\n') +
  '\nRewrite the reply once so it follows them. Change only what the rules require.'

/** A short stable hash of the instruction files, so the rules are extracted once per version. */
export function filesHash(files: Array<{ path: string; text: string }>): string {
  let h = 2166136261
  for (const ch of files.map(f => `${f.path}\0${f.text}`).join('\0')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
  return h.toString(36)
}
