/**
 * Skill-name helpers: the kebab-case grammar enforced by the DSH skill
 * registry (see packages/skill/skill/src/index.ts) plus slug generation.
 */

/** Public skill-name grammar: lowercase alphanumerics joined by single hyphens. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Return whether a string is a valid kebab-case skill name. */
export function isSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name)
}

/**
 * Slugify free text into a kebab-case identifier. Non-alphanumeric runs become
 * single hyphens; leading/trailing hyphens are stripped. Returns '' for input
 * with no usable character.
 */
export function slugifySkillName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
}

/**
 * Suggest a unique skill name from a goal sentence: slugify the first line,
 * then dedupe against `used`.
 */
export function suggestSkillName(goal: string, used: ReadonlySet<string> = new Set()): string {
  const firstLine = goal.split(/[\n。.；;，,]/)[0] ?? 'custom-skill'
  let base = slugifySkillName(firstLine)
  if (base.length === 0) base = 'custom-skill'
  if (base.length > 40) base = base.slice(0, 40).replace(/-+$/, '')
  if (base.length === 0) base = 'custom-skill'
  if (!used.has(base)) return base
  let i = 2
  while (used.has(`${base}-${i}`)) i += 1
  return `${base}-${i}`
}