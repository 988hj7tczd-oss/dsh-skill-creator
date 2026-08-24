/**
 * dsh-skill-creator plugin assembly.
 *
 * Registers the four model tools (skill_new, skill_validate, skill_package,
 * skill_improve_description) via `defineTool` and mounts the plugin's output
 * directory as a runtime skill source on `ctx.skills` when the registry is
 * present (the built-in "output dir mount" mechanism).
 *
 * When the skills registry is unavailable the plugin falls back to a
 * human-readable mount hint (skill-filesystem `customSkillDirs`) that the
 * skill_new tool returns to the user.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { makeHostFs } from './lib/fs-adapter.ts'
import { mountRuntimeProvider } from './lib/provider.ts'
import type { ToolRunContext, ToolSpec } from './lib/tool-spec.ts'
import { skillNewTool } from './tools/skill-new.ts'
import { skillValidateTool } from './tools/skill-validate.ts'
import { skillPackageTool } from './tools/skill-package.ts'
import { skillImproveDescriptionTool } from './tools/skill-improve-description.ts'

export const name = 'skill-creator'
export const inject = ['tools']

/** Plugin configuration (all fields optional). */
export interface Config {
  /** Skill output root. Default: first entry of customSkillDirs, else `$DSH_HOME/skills`. */
  outputDir?: string
  /** Additional roots scanned by the runtime provider (mirrors skill-filesystem customSkillDirs). */
  customSkillDirs?: string[]
  /** Register the output roots as a runtime skill source on `ctx.skills`. Default: true. */
  mountRuntimeProvider?: boolean
}

/** Cordis/Schemastery schema — validated at load by the runtime. */
export const Config: z<Config> = z.object({
  outputDir: z.string(),
  customSkillDirs: z.array(String),
  mountRuntimeProvider: z.boolean(),
})

/** Plugin-config defaults merged over the runtime-validated config in apply(). */
const DEFAULTS: Config = {
  mountRuntimeProvider: true,
}

const TOOL_SPECS: readonly ToolSpec[] = [
  skillNewTool,
  skillValidateTool,
  skillPackageTool,
  skillImproveDescriptionTool,
]

function defaultOutputRoot(): string {
  const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(dshHome, 'skills')
}

export function apply(ctx: Context, rawConfig: Partial<Config> = {}): void {
  const config: Config = { ...DEFAULTS, ...rawConfig }
  const customSkillDirs = config.customSkillDirs ?? []
  const outputDir = config.outputDir && config.outputDir.trim().length > 0
    ? config.outputDir.trim()
    : customSkillDirs.length > 0
      ? customSkillDirs[0]!
      : defaultOutputRoot()
  const allRoots = [outputDir, ...customSkillDirs.filter((root) => root !== outputDir)]

  // Tool context: expose plugin config through the same `get` surface.
  const toolCtx: ToolRunContext = {
    get(key: string): unknown {
      if (key === 'skill-creator/config') {
        return { outputDir, customSkillDirs: allRoots, mountRuntimeProvider: config.mountRuntimeProvider !== false }
      }
      return ctx.get(key)
    },
  }

  for (const spec of TOOL_SPECS) {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters as never,
      output: {
        schema: spec.outputSchema as never,
        render: (args, value) => spec.render(args as never, value) as never,
        ...(spec.presentationMeta !== undefined
          ? { presentationMeta: (args: never, value: never) => spec.presentationMeta!(args, value) as never }
          : {}),
      },
      async execute(args, exec) {
        return (await spec.run(toolCtx, args as never, exec.signal)) as never
      },
    }))
  }

  // Built-in output-directory mount (best effort).
  if (config.mountRuntimeProvider !== false) {
    const fs = makeHostFs(ctx)
    const report = mountRuntimeProvider(ctx, fs, allRoots)
    if (report.mounted) {
      ctx.logger.info(`[skill-creator] runtime skill provider mounted on ${allRoots.join(', ')}`)
    } else {
      ctx.logger.warn(`[skill-creator] ${report.reason ?? 'runtime provider not mounted'}; fall back to customSkillDirs=${allRoots.join(', ')}`)
    }
  } else {
    ctx.logger.info(`[skill-creator] runtime provider disabled; rely on skill-filesystem customSkillDirs (${allRoots.join(', ')})`)
  }
  ctx.logger.info(`[skill-creator] loaded: ${TOOL_SPECS.length} tools (${TOOL_SPECS.map((spec) => spec.name).join(', ')}); outputDir=${outputDir}`)
}