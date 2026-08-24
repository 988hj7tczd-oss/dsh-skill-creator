/**
 * skill_new core: capture intent (extract steps/tools/formats/gaps from a goal
 * description), produce clarification questions for the dry-run pass, build a
 * SKILL.md draft (frontmatter + workflow/input-output/boundaries/example body)
 * and write it under an output root.
 */

import { join } from 'node:path'
import type { HostFs } from './fs-adapter.ts'
import { formatFrontmatter } from './frontmatter.ts'
import { isSkillName, slugifySkillName, suggestSkillName } from './skill-name.ts'

export interface IntentExtraction {
  readonly steps: readonly string[]
  readonly tools: readonly string[]
  readonly formats: readonly string[]
  readonly gaps: readonly string[]
}

const STEP_LINE = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/
const NUMBERED_STEP = /^\d+[.、]\s*(.*)$/
const TOOL_BACKTICK = /`([a-zA-Z][a-zA-Z0-9_.-]*)`/g
const TOOL_PHRASE = /(?:使用|用|调用|运行|跑)\s*([a-zA-Z][a-zA-Z0-9_.-]*)/
const FORMAT_LINE = /(?:输入|输出|格式)[:：]?\s*([^。;；,，\n]+)/
const GAP_PATTERN = /TODO|待定|待补充|待确认|未知|\?\?\?|FIXME|不确定|需要确认|请确认|需用户/

function trimSentenceEnd(text: string): string {
  return text.replace(/[。.；;，,、\s]+$/, '')
}

/**
 * Lightweight intent extraction from a free-text workflow description.
 * Heuristic and deterministic (no model required); the model/user may refine
 * the result through the clarification questions.
 */
export function extractIntent(goal: string): IntentExtraction {
  const lines = goal.split(/\n+/).map((line) => line.trim()).filter((line) => line.length > 0)
  const steps: string[] = []
  const tools = new Set<string>()
  const formats = new Set<string>()
  const gaps = new Set<string>()

  for (const line of lines) {
    const step = STEP_LINE.exec(line) ?? NUMBERED_STEP.exec(line)
    if (step !== null) steps.push(trimSentenceEnd(step[1]!))
    for (const match of line.matchAll(TOOL_BACKTICK)) tools.add(match[1]!)
    const toolPhrase = TOOL_PHRASE.exec(line)
    if (toolPhrase !== null) {
      tools.add(toolPhrase[1]!.replace(/(工具|命令|脚本)$/, '').trim())
    }
    if (/(输入|输出|格式|sample|example)/i.test(line)) {
      const format = FORMAT_LINE.exec(line)
      if (format !== null) formats.add(trimSentenceEnd(format[1]!))
    }
    if (GAP_PATTERN.test(line)) gaps.add(trimSentenceEnd(line))
  }

  return {
    steps: unique(steps),
    tools: [...tools],
    formats: [...formats],
    gaps: [...gaps],
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

/** Clarification questions for the dry-run pass, honouring extraction gaps. */
export function buildClarifyingQuestions(goal: string, extraction: IntentExtraction): string[] {
  const questions: string[] = []
  if (extraction.steps.length === 0) {
    questions.push('目标流程缺少可执行的步骤序列：请把工作流拆成逐步描述（可用编号或列表）。')
  }
  if (extraction.tools.length === 0) {
    questions.push('未识别到任何工具/命令：这个流程会用到哪些工具？（如 bash、read、grep、write、edit 等）')
  }
  if (extraction.formats.length === 0) {
    questions.push('未识别到输入/输出格式：请描述输入什么、产出什么（文件、字段、格式、产物目录）。')
  }
  for (const gap of extraction.gaps) {
    questions.push(`存在待确认项："${gap}" —— 请补充具体内容。`)
  }
  if (questions.length === 0) {
    questions.push('抽取的步骤/工具/格式看起来完整：确认即可生成草稿；如有边界条件、反例或注意事项请一并补充。')
  }
  return questions
}

export interface SkillDraft {
  readonly name: string
  readonly description: string
  readonly content: string
  readonly extraction: IntentExtraction
}

/** Build the trigger description following the `Use when ...` convention. */
export function buildTriggerDescription(goal: string, extraction: IntentExtraction): string {
  const firstLine = goal.split(/\n+/).map((line) => line.trim()).find((line) => line.length > 0) ?? goal
  const cleaned = trimSentenceEnd(firstLine)
    .replace(/^请\s*(?:帮助|帮)?\s*/u, '')
    .replace(/^(帮我|请)$/u, '')
  const core = cleaned.length > 140 ? trimSentenceEnd(cleaned.slice(0, 140)) : cleaned
  const toolPart = extraction.tools.length > 0
    ? `, especially when using ${extraction.tools.slice(0, 3).map((tool) => `\`${tool}\``).join(', ')}`
    : ''
  return `Use when ${core}${toolPart}.`
}

function renderSkillMarkdown(draft: Omit<SkillDraft, 'content'>): string {
  const { name, description, extraction } = draft
  const sections: string[] = []
  sections.push(`# ${name}`)
  sections.push('')
  sections.push(description)
  sections.push('')
  sections.push('## Workflow / 工作流')
  sections.push('')
  const steps = extraction.steps.length > 0 ? extraction.steps : []
  if (steps.length === 0) {
    sections.push('1. 明确任务输入（必要时向用户确认缺失信息）。')
    sections.push('2. 按下方输入/输出约定执行核心处理。')
    sections.push('3. 校验结果完整性并汇报产出。')
  } else {
    steps.forEach((step, index) => sections.push(`${index + 1}. ${step}`))
  }
  if (extraction.tools.length > 0) {
    sections.push('')
    sections.push(`**Tools**: ${extraction.tools.map((tool) => `\`${tool}\``).join(', ')}`)
  }
  sections.push('')
  sections.push('## Inputs and outputs / 输入与输出')
  sections.push('')
  if (extraction.formats.length === 0) {
    sections.push('- 输入 / 输出格式按实际任务确定；关键信息缺失时先向用户确认，不擅自假设。')
  } else {
    extraction.formats.forEach((format) => sections.push(`- ${format}`))
  }
  sections.push('')
  sections.push('## Boundaries / 边界与排除')
  sections.push('')
  sections.push('- 只在本技能声明的范围内工作；超出范围时明确说明并停止。')
  sections.push('- 不修改与任务无关的文件；改动任何文件前先读取目标内容。')
  sections.push('- 涉及持久化产物时，写出目录/格式遵循用户或项目的既有约定。')
  sections.push('')
  sections.push('## Example / 示例')
  sections.push('')
  sections.push(`> 请用 "${name}" 技能处理：<输入样例>`)
  sections.push('')
  sections.push('按"工作流"逐步执行，并在过程中报告关键中间结果与最终产出。')
  sections.push('')
  return sections.join('\n')
}

/**
 * Build a complete skill draft from a goal description plus optional explicit
 * name/description overrides.
 */
export function buildSkillDraft(
  goal: string,
  opts: { name?: string; description?: string } = {},
): SkillDraft {
  const extraction = extractIntent(goal)
  let name: string
  if (opts.name !== undefined && opts.name.length > 0) {
    const slug = slugifySkillName(opts.name)
    const candidate = slug.length > 0 ? slug : suggestSkillName(goal)
    name = isSkillName(candidate) ? candidate : suggestSkillName(goal)
  } else {
    name = suggestSkillName(goal)
  }
  const description = opts.description !== undefined && opts.description.trim().length > 0
    ? opts.description.trim()
    : buildTriggerDescription(goal, extraction)
  return { name, description, content: renderSkillMarkdown({ name, description, extraction }), extraction }
}

/** Write a draft as `<outputDir>/<name>/SKILL.md`; returns created paths. */
export async function writeSkillDraft(fs: HostFs, outputDir: string, draft: SkillDraft): Promise<{ dir: string; path: string }> {
  const dir = join(outputDir, draft.name)
  await fs.mkdirp(dir)
  const path = join(dir, 'SKILL.md')
  const file = formatFrontmatter({ name: draft.name, description: draft.description }) + draft.content
  await fs.writeText(path, file)
  return { dir, path }
}