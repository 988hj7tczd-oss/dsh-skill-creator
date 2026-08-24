/**
 * Tool-environment helpers: plugin config access, output-root resolution and
 * mounting hints. Dependency-free (only Node builtins) so tools stay testable
 * offline.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ToolRunContext } from './tool-spec.ts'

export interface SkillCreatorConfig {
  readonly outputDir?: string
  readonly customSkillDirs?: readonly string[]
  readonly mountRuntimeProvider?: boolean
}

const CONFIG_KEY = 'skill-creator/config'

/** Read the plugin config that `src/index.ts` attaches to the tool context. */
export function readCreatorConfig(ctx: ToolRunContext): SkillCreatorConfig {
  const value = ctx.get(CONFIG_KEY)
  if (typeof value === 'object' && value !== null) return value as SkillCreatorConfig
  return {}
}

/** Default skill output root: `$DSH_HOME/skills` or `~/.dsh/skills`. */
export function defaultSkillsRoot(): string {
  const dshHome = typeof process !== 'undefined' && process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(dshHome, 'skills')
}

/** Resolve the skill output root: arg > config.outputDir > customSkillDirs[0] > default. */
export function resolveOutputRoot(ctx: ToolRunContext, explicit?: string): string {
  if (explicit !== undefined && explicit.trim().length > 0) return explicit.trim()
  const config = readCreatorConfig(ctx)
  if (config.outputDir !== undefined && config.outputDir.trim().length > 0) return config.outputDir.trim()
  if (config.customSkillDirs !== undefined && config.customSkillDirs.length > 0 && config.customSkillDirs[0]!.trim().length > 0) {
    return config.customSkillDirs[0]!.trim()
  }
  return defaultSkillsRoot()
}

/** Markdown-embedded YAML hint shown after skill_new writes a skill. */
export function mountHintYaml(skillDir: string, outputRoot: string): string {
  return [
    '# 为 skill-filesystem 增加自定义技能根（profiles/<name>/cordis.patch.yml 或 home 覆盖层）：',
    '- id: skill-filesystem',
    "  name: '@deepseek-ai/dsh-skill-filesystem'",
    '  config:',
    '    customSkillDirs:',
    `      - ${outputRoot}`,
    `# 生效后 ${skillDir}/SKILL.md 即可被 skill 工具列出并加载。`,
  ].join('\n')
}

/** Best-effort recent-session tail extraction (session service duck typing). */
export function extractSessionTail(session: unknown): string | undefined {
  if (typeof session !== 'object' || session === null) return undefined
  const candidate = session as { messages?: unknown; history?: unknown; turns?: unknown }
  const messages = Array.isArray(candidate.messages)
    ? candidate.messages
    : Array.isArray(candidate.history)
      ? candidate.history
      : Array.isArray(candidate.turns)
        ? candidate.turns
        : undefined
  if (messages === undefined || messages.length === 0) return undefined
  const tail: string[] = []
  for (const message of messages.slice(-6)) {
    const entry = message as { content?: unknown; text?: unknown }
    const content = typeof entry.content === 'string'
      ? entry.content
      : typeof entry.text === 'string'
        ? entry.text
        : undefined
    if (content !== undefined) tail.push(content)
  }
  const text = tail.join('\n').trim()
  return text.length > 0 ? text.slice(-3000) : undefined
}