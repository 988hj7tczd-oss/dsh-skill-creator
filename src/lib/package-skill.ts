/**
 * `.skill` packaging: validate first, then collect files with the upstream
 * exclusion rules and write a ZIP whose structure is `<skill-name>/ + content`.
 *
 * Exclusion rules (ported as behaviour from the upstream package_skill.py):
 *   EXCLUDE_DIRS  = { "__pycache__", "node_modules" }  (any depth)
 *   EXCLUDE_GLOBS = { "*.pyc" }                        (any depth)
 *   EXCLUDE_FILES = { ".DS_Store" }                    (any depth)
 *   "evals/" is excluded only at the skill root.
 */

import { basename, dirname, join, relative, sep } from 'node:path'
import type { HostFs } from './fs-adapter.ts'
import { formatChecks, validateSkillDir, type ValidationResult } from './validate-skill.ts'
import { buildZip, type ZipEntry } from './zip.ts'

export const PACKAGE_EXCLUDE_DIRS: ReadonlySet<string> = new Set(['__pycache__', 'node_modules'])
export const PACKAGE_EXCLUDE_GLOBS: readonly string[] = ['*.pyc']
export const PACKAGE_EXCLUDE_FILES: ReadonlySet<string> = new Set(['.DS_Store'])
const SKILL_ROOT_EVALS = 'evals'

/** Simple glob matching supporting `*` and `?`. */
export function matchSimpleGlob(glob: string, name: string): boolean {
  const pattern = '^' + glob.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
  return new RegExp(pattern).test(name)
}

/**
 * Apply the upstream exclusion rules to one path relative to the skill root.
 * `isDirectory` distinguishes directory-only rules (excluded dirs are pruned
 * during the walk, so their children never surface).
 */
export function shouldExcludeSkillPath(rel: string, isDirectory: boolean): boolean {
  const segments = rel.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0) return false
  const base = segments[segments.length - 1]!
  if (isDirectory) {
    if (PACKAGE_EXCLUDE_DIRS.has(base)) return true
    // evals/ is excluded only when it is a direct child of the skill root.
    if (segments.length === 1 && base === SKILL_ROOT_EVALS) return true
    return false
  }
  if (PACKAGE_EXCLUDE_FILES.has(base)) return true
  for (const glob of PACKAGE_EXCLUDE_GLOBS) {
    if (matchSimpleGlob(glob, base)) return true
  }
  return false
}

export interface CollectedFile {
  readonly abs: string
  readonly rel: string
}

export interface CollectedSkill {
  readonly name: string
  readonly files: readonly CollectedFile[]
}

/** Recursively collect packageable files under a skill directory. */
export async function collectSkillFiles(fs: HostFs, skillDir: string): Promise<CollectedSkill> {
  const name = basename(skillDir)
  const files: CollectedFile[] = []
  async function walk(current: string): Promise<void> {
    let entries: string[]
    try {
      entries = await fs.listDir(current)
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = join(current, entry)
      const rel = relative(skillDir, abs).split(sep).join('/')
      let isDir = false
      let isFile = false
      try {
        const info = await fs.stat(abs)
        if (info === undefined) continue
        isDir = info.type === 'dir'
        isFile = info.type === 'file'
      } catch {
        // unreadable entry: skip
      }
      if (shouldExcludeSkillPath(rel, isDir)) continue
      if (isDir) {
        await walk(abs)
      } else if (isFile) {
        files.push({ abs, rel })
      }
    }
  }
  await walk(skillDir)
  return { name, files }
}

export interface SkillPackageResult {
  readonly ok: boolean
  readonly skillName: string
  readonly outPath: string
  readonly entries: readonly string[]
  readonly validation: ValidationResult
}

/**
 * Package a validated skill directory into `<skillName>.skill`. Throws when
 * validation fails (mirroring the upstream "refuse to package" behaviour).
 */
export async function packSkillDir(fs: HostFs, skillDir: string, outDir?: string): Promise<SkillPackageResult> {
  const validation = await validateSkillDir(fs, skillDir)
  if (!validation.ok) {
    throw new Error(`packSkill: validation failed:\n${formatChecks(validation.checks)}`)
  }
  const collected = await collectSkillFiles(fs, skillDir)
  if (collected.files.length === 0) {
    throw new Error('packSkill: no files to package')
  }

  const entries: ZipEntry[] = [{ name: `${collected.name}/`, data: new Uint8Array(0) }]
  for (const file of collected.files) {
    const content = await fs.readText(file.abs)
    entries.push({ name: `${collected.name}/${file.rel}`, data: new TextEncoder().encode(content) })
  }
  const zipBytes = buildZip(entries)

  const outPath = outDir !== undefined && outDir.length > 0
    ? join(outDir, `${collected.name}.skill`)
    : join(dirname(skillDir), `${collected.name}.skill`)
  await fs.mkdirp(dirname(outPath))
  await fs.writeBin(outPath, zipBytes)

  return {
    ok: true,
    skillName: collected.name,
    outPath,
    entries: entries.map((entry) => entry.name),
    validation,
  }
}