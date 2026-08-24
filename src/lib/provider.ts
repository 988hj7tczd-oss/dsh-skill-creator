/**
 * Built-in "output directory mount": a runtime skill source over the plugin's
 * configured output roots. It is registered on `ctx.skills` via
 * `registerProvider` when the registry service is present, so skills written by
 * skill_new become listable/loadable without touching skill-filesystem config.
 * Sources/rules mirror the filesystem provider's discovery contract: each root
 * holds `<name>/SKILL.md` directories with valid frontmatter.
 */

import { dirname, join } from 'node:path'
import type { HostFs } from './fs-adapter.ts'
import { parseSimpleYaml, splitFrontmatter } from './frontmatter.ts'
import { isSkillName } from './skill-name.ts'

export interface RuntimeSkillListing {
  readonly name: string
  readonly description: string
  readonly path: string
  readonly dir: string
  readonly provider: string
  readonly source: string
  readonly rank: number
}

export interface RuntimeSkillDefinition {
  readonly name: string
  readonly description: string
  readonly content: string
  readonly path: string
  readonly provider: string
  readonly source: string
  readonly resourceBase: { kind: 'directory'; path: string }
}

/** Scans one or more output roots for `<name>/SKILL.md` skills. */
export class OutputDirSkillSource {
  private readonly fs: HostFs
  private readonly roots: readonly string[]

  constructor(fs: HostFs, roots: readonly string[]) {
    this.fs = fs
    this.roots = roots
  }

  /** Discover valid skills across all roots (invalid entries are skipped). */
  async list(): Promise<RuntimeSkillListing[]> {
    const listings: RuntimeSkillListing[] = []
    for (const root of this.roots) {
      let entries: string[]
      try {
        entries = await this.fs.listDir(root)
      } catch {
        continue // absent root is not an error; the provider may not be mounted yet
      }
      for (const entry of entries) {
        const dir = join(root, entry)
        let info
        try {
          info = await this.fs.stat(dir)
        } catch {
          continue
        }
        if (info === undefined || info.type !== 'dir') continue
        const path = join(dir, 'SKILL.md')
        try {
          info = await this.fs.stat(path)
        } catch {
          continue
        }
        if (info === undefined || info.type !== 'file') continue
        let raw: string
        try {
          raw = await this.fs.readText(path)
        } catch {
          continue
        }
        const parsed = parseSkillListing(raw)
        if (parsed === undefined) continue
        listings.push({ ...parsed, path, dir, provider: 'skill-creator', source: 'custom', rank: 300 })
      }
    }
    return listings
  }

  /** Load the body for exactly one skill name. */
  async get(name: string): Promise<RuntimeSkillDefinition | undefined> {
    const listing = (await this.list()).find((candidate) => candidate.name === name)
    if (listing === undefined) return undefined
    let raw: string
    try {
      raw = await this.fs.readText(listing.path)
    } catch {
      return undefined
    }
    const split = splitFrontmatter(raw)
    if (split === undefined) return undefined
    return {
      name: listing.name,
      description: listing.description,
      content: split.body,
      path: listing.path,
      provider: listing.provider,
      source: listing.source,
      resourceBase: { kind: 'directory', path: dirname(listing.path) },
    }
  }
}

function parseSkillListing(raw: string): Pick<RuntimeSkillListing, 'name' | 'description'> | undefined {
  const split = splitFrontmatter(raw)
  if (split === undefined) return undefined
  let data: Record<string, unknown>
  try {
    data = parseSimpleYaml(split.yaml)
  } catch {
    return undefined
  }
  const name = typeof data.name === 'string' && data.name.length > 0 ? data.name : undefined
  const description = typeof data.description === 'string' && data.description.length > 0 ? data.description : undefined
  if (name === undefined || description === undefined || !isSkillName(name)) return undefined
  return { name, description }
}

/** Duck-typed subset of the `ctx.skills` registry service. */
export interface SkillRegistryLike {
  registerProvider(
    create: (control: { invalidate(): void }) => {
      name: string
      list?(options?: unknown): Promise<unknown[]>
      get?(candidate: unknown, options?: unknown): Promise<unknown | undefined>
    },
  ): () => void
}

/** Return whether a value looks like the skills registry service. */
export function isSkillRegistryLike(value: unknown): value is SkillRegistryLike {
  if (typeof value !== 'object' || value === null) return false
  return typeof (value as SkillRegistryLike).registerProvider === 'function'
}

export interface MountReport {
  readonly mounted: boolean
  readonly reason?: string
}

/**
 * Mount a runtime provider for the given output roots. Best effort: when the
 * `skills` registry is absent the reporter explains how to mount manually via
 * skill-filesystem `customSkillDirs`.
 */
export function mountRuntimeProvider(
  ctx: { get(name: string): unknown },
  fs: HostFs,
  roots: readonly string[],
): MountReport {
  const registry = ctx.get('skills')
  if (!isSkillRegistryLike(registry)) {
    return {
      mounted: false,
      reason: 'skills registry unavailable (is @deepseek-ai/dsh-skill installed?) — 请改用 skill-filesystem 的 customSkillDirs 手工挂载',
    }
  }
  const source = new OutputDirSkillSource(fs, roots)
  registry.registerProvider((_control) => ({
    name: 'skill-creator',
    async list() {
      return await source.list()
    },
    async get(candidate: { name?: unknown }) {
      const name = typeof candidate?.name === 'string' ? candidate.name : undefined
      if (name === undefined) return undefined
      return await source.get(name)
    },
  }))
  return { mounted: true }
}