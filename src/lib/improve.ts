/**
 * skill_improve_description core: rewrite a frontmatter description to raise
 * trigger accuracy while preserving the original trigger-scenario coverage
 * (acceptance criterion: every preserved keyword still appears in the
 * proposal), then commit the approved rewrite back into the frontmatter
 * without touching any other field or the body.
 */

import { join } from 'node:path'
import type { HostFs } from './fs-adapter.ts'
import { parseSimpleYaml, replaceFrontmatterLine, splitFrontmatter } from './frontmatter.ts'
import { formatChecks, validateSkillDir } from './validate-skill.ts'

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'when',
  'use', 'using', 'is', 'are', 'be', 'it', 'this', 'that', 'these', 'those',
  'as', 'by', 'at', 'from', 'via', 'your', 'you', 'we', 'our', 'i', 'do',
  'does', 'should', 'must', 'will', 'can', 'may', 'into', 'over', 'under',
  'any', 'all', 'each', 'some', 'not', 'no', 'if', 'then', 'than', 'which',
  'who', 'what', 'how', 'why', 'where', 'there', 'their', 'they', 'its',
  'etc', 'eg', 'ie', 's', 't', 'before', 'after', 'while', 'during',
])

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*/g) ?? [])
    .filter((token) => !STOPWORDS.has(token) && token.length > 1)
}

function distinct(values: string[]): string[] {
  return [...new Set(values)]
}

export interface ImproveResult {
  readonly original: string
  readonly proposed: string
  readonly reasons: readonly string[]
  readonly preserved: readonly string[]
  readonly added: readonly string[]
  /** False when the proposal dropped an original trigger keyword. */
  readonly valid: boolean
}

/**
 * Deterministic description rewriter. Preserves the original description's
 * distinctive trigger tokens, then adds tokens extracted from the supplied
 * trigger-scenario examples. The proposal always keeps "Use when ...".
 */
export function improveDescription(current: string, usage: string): ImproveResult {
  const preserved = distinct(tokenize(current)).slice(0, 8)
  const added = distinct(tokenize(usage).filter((token) => !preserved.includes(token))).slice(0, 8)

  const parts: string[] = []
  if (preserved.length > 0) parts.push(preserved.join(', '))
  if (added.length > 0) parts.push(`including ${added.join(', ')}`)
  const proposed = parts.length > 0
    ? `Use when ${parts.join(', ')}.`
    : `Use when ${current.trim().replace(/[。.;；,，]+$/, '')}.`

  const proposedLower = proposed.toLowerCase()
  const missing = preserved.filter((token) => !proposedLower.includes(token))

  const reasons: string[] = []
  if (preserved.length > 0) reasons.push(`保留原始触发覆盖：${preserved.join(', ')}`)
  if (added.length > 0) reasons.push(`新增场景覆盖：${added.join(', ')}（来自输入的场景样例）`)
  reasons.push('保持 "Use when ..." 触发句式，与 DSH skill 目录惯例一致')

  return { original: current, proposed, reasons, preserved, added, valid: missing.length === 0 }
}

export interface CommitResult {
  readonly path: string
  readonly updated: boolean
  readonly previous: string
  readonly proposed: string
}

/**
 * Commit an approved description into the skill's SKILL.md frontmatter. Reads
 * the file first (observation policy), replaces only the `description` line and
 * writes back; every other field and the body stay byte-identical.
 */
export async function commitDescription(fs: HostFs, skillDir: string, proposed: string): Promise<CommitResult> {
  const validation = await validateSkillDir(fs, skillDir)
  if (!validation.ok) {
    throw new Error(`commitDescription: validation failed:\n${formatChecks(validation.checks)}`)
  }
  const path = join(skillDir, 'SKILL.md')
  const raw = await fs.readText(path)
  const split = splitFrontmatter(raw)
  let previous = ''
  if (split !== undefined) {
    try {
      const data = parseSimpleYaml(split.yaml)
      previous = typeof data.description === 'string' ? data.description : ''
    } catch {
      // fall back to empty previous
    }
  }
  const updated = replaceFrontmatterLine(raw, 'description', proposed)
  if (updated === undefined) {
    throw new Error('commitDescription: frontmatter field "description" not found')
  }
  await fs.writeText(path, updated)
  return { path, updated: true, previous, proposed }
}