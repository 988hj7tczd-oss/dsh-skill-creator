/**
 * Skill directory validation: SKILL.md exists, frontmatter parses, name and
 * description are present and valid. Behaviour (checks and error wording)
 * mirrors the upstream skill-creator quick_validate.py; implementation is an
 * independent TypeScript port.
 */

import { join } from 'node:path'
import type { HostFs } from './fs-adapter.ts'
import { parseSimpleYaml, splitFrontmatter, YamlError } from './frontmatter.ts'
import { isSkillName } from './skill-name.ts'

export interface ValidationCheck {
  readonly item: string
  readonly ok: boolean
  readonly message: string
}

export interface ValidationResult {
  readonly ok: boolean
  readonly checks: readonly ValidationCheck[]
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Render checks as human-readable pass/fail lines. */
export function formatChecks(checks: readonly ValidationCheck[]): string {
  return checks.map((check) => `${check.ok ? 'PASS' : 'FAIL'} ${check.item} — ${check.message}`).join('\n')
}

/**
 * Validate a skill directory. Returns the first failing check plus every check
 * run before it; `ok` is true only when all checks pass.
 */
export async function validateSkillDir(fs: HostFs, dir: string): Promise<ValidationResult> {
  const checks: ValidationCheck[] = []
  const skillPath = join(dir, 'SKILL.md')

  const stat = await fs.stat(skillPath)
  if (stat === undefined || stat.type !== 'file') {
    return {
      ok: false,
      checks: [{ item: 'SKILL.md exists', ok: false, message: `skill file SKILL.md not found at ${dir}` }],
    }
  }
  checks.push({ item: 'SKILL.md exists', ok: true, message: `found at ${skillPath}` })

  let raw: string
  try {
    raw = await fs.readText(skillPath)
  } catch (error) {
    return { ok: false, checks: [...checks, { item: 'SKILL.md readable', ok: false, message: `cannot read: ${String(error)}` }] }
  }
  checks.push({ item: 'SKILL.md readable', ok: true, message: `${raw.length} chars` })

  const split = splitFrontmatter(raw)
  if (split === undefined) {
    return { ok: false, checks: [...checks, { item: 'frontmatter', ok: false, message: 'missing YAML frontmatter' }] }
  }
  checks.push({ item: 'frontmatter', ok: true, message: 'YAML frontmatter present' })

  let data: Record<string, unknown>
  try {
    data = parseSimpleYaml(split.yaml)
  } catch (error) {
    const detail = error instanceof YamlError ? error.message : String(error)
    return { ok: false, checks: [...checks, { item: 'frontmatter', ok: false, message: `invalid YAML frontmatter: ${detail}` }] }
  }
  checks.push({ item: 'frontmatter', ok: true, message: 'parses as a YAML mapping' })

  const name = stringField(data, 'name')
  const description = stringField(data, 'description')
  if (name === undefined || description === undefined) {
    const missing = [name === undefined ? 'name' : null, description === undefined ? 'description' : null]
      .filter((entry): entry is string => entry !== null)
    return {
      ok: false,
      checks: [...checks, { item: 'frontmatter fields', ok: false, message: `frontmatter requires ${missing.join(' and ')}` }],
    }
  }
  checks.push({ item: 'name', ok: true, message: `present: ${name}` })
  checks.push({ item: 'description', ok: true, message: `present (${description.length} chars)` })

  if (!isSkillName(name)) {
    return { ok: false, checks: [...checks, { item: 'name', ok: false, message: `invalid skill name "${name}"` }] }
  }
  checks.push({ item: 'name', ok: true, message: 'valid kebab-case skill name' })

  const body = split.body.trim()
  checks.push({
    item: 'body',
    ok: body.length > 0,
    message: body.length > 0 ? `body present (${body.length} chars)` : 'empty body (skill carries no instructions)',
  })

  return { ok: checks.every((check) => check.ok), checks }
}