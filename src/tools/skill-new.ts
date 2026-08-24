/**
 * skill_new — capture intent and generate a DSH skill (SKILL.md) draft.
 *
 * Dry-run (confirm=false): returns the intent extraction plus clarification
 * questions (Capture Intent step), writing nothing. confirm=true writes
 * `<outputRoot>/<name>/SKILL.md` and returns the mount hint.
 */

import { makeHostFs } from '../lib/fs-adapter.ts'
import { textBlock, optString, errorResult, type ToolRunContext, type ToolSpec } from '../lib/tool-spec.ts'
import { buildClarifyingQuestions, buildSkillDraft, extractIntent, writeSkillDraft } from '../lib/draft.ts'
import { extractSessionTail, mountHintYaml, resolveOutputRoot } from '../lib/tool-env.ts'

export const skillNewTool: ToolSpec = {
  name: 'skill_new',
  description: 'Capture a workflow and generate a DSH skill (SKILL.md). Dry-run first (confirm=false) to get intent-clarification questions; confirm=true writes the skill under the output dir.',
  parameters: {
    goal: { type: 'string', required: true, description: 'The workflow to freeze into a skill: steps, tools, input/output formats, boundaries, examples.' },
    fromSession: { type: 'boolean', description: 'Best-effort extraction of context from the current session history.' },
    name: { type: 'string', description: 'Optional skill name (kebab-case). Default: derived from the goal.' },
    description: { type: 'string', description: 'Optional trigger description. Default: generated "Use when ..." line.' },
    outputDir: { type: 'string', description: 'Skill output root. Default: plugin config outputDir, then customSkillDirs[0], then $DSH_HOME/skills.' },
    confirm: { type: 'boolean', description: 'false = dry-run (returns clarification questions, writes nothing); true = write SKILL.md.' },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string' },
      skillName: { type: 'string' },
      dir: { type: 'string' },
      path: { type: 'string' },
      sessionNote: { type: 'string' },
      questions: { type: 'array', items: { type: 'string' } },
      extraction: {
        type: 'object',
        additionalProperties: true,
        properties: {
          steps: { type: 'array', items: { type: 'string' } },
          tools: { type: 'array', items: { type: 'string' } },
          formats: { type: 'array', items: { type: 'string' } },
          gaps: { type: 'array', items: { type: 'string' } },
        },
      },
      mountHint: { type: 'string' },
      message: { type: 'string' },
    },
  },
  render(_args, value) {
    return [textBlock(renderSkillNewText(value))]
  },
  presentationMeta(_args, value) {
    const record = value as Record<string, unknown>
    return {
      status: typeof record.status === 'string' ? record.status : 'unknown',
      skillName: typeof record.skillName === 'string' ? record.skillName : null,
      dir: typeof record.dir === 'string' ? record.dir : null,
      path: typeof record.path === 'string' ? record.path : null,
    }
  },
  async run(ctx: ToolRunContext, args: Record<string, unknown>, signal?: AbortSignal) {
    const goal = typeof args.goal === 'string' ? args.goal.trim() : ''
    if (goal.length === 0) return errorResult('goal is required')
    const confirm = args.confirm === true
    const fromSession = args.fromSession === true
    const fs = makeHostFs(ctx, signal)

    let sessionNote: string
    if (fromSession) {
      const tail = extractSessionTail(ctx.get('session'))
      sessionNote = tail !== undefined
        ? `已从会话历史抽取最近片段（约 ${tail.length} 字符）并入分析。`
        : '当前上下文未提供会话历史（session 服务不可用），仅按 goal 抽取。'
    } else {
      sessionNote = '未请求会话历史（fromSession=false）。'
    }

    const extraction = extractIntent(goal)
    if (!confirm) {
      const questions = buildClarifyingQuestions(goal, extraction)
      return {
        status: 'needs-confirmation',
        extraction,
        questions,
        sessionNote,
        message: '请先确认意图：回答上方澄清问题（或直接补充 goal 后重试）；确认无误后以 confirm=true 重新调用以生成 SKILL.md。',
      }
    }

    const outputRoot = resolveOutputRoot(ctx, optString(args, 'outputDir'))
    const draft = buildSkillDraft(goal, {
      name: optString(args, 'name'),
      description: optString(args, 'description'),
    })
    const written = await writeSkillDraft(fs, outputRoot, draft)
    return {
      status: 'created',
      skillName: draft.name,
      dir: written.dir,
      path: written.path,
      extraction,
      mountHint: mountHintYaml(written.dir, outputRoot),
      message: 'SKILL.md 已写入。若启用 mountRuntimeProvider，该目录已由插件运行期注册到 ctx.skills；否则请按 mountHint 将输出根加入 skill-filesystem 的 customSkillDirs。',
    }
  },
}

function renderSkillNewText(value: unknown): string {
  const record = value as Record<string, unknown>
  const lines: string[] = []
  const status = typeof record.status === 'string' ? record.status : 'unknown'
  lines.push(`[skill_new] status=${status}`)
  if (typeof record.skillName === 'string') lines.push(`skillName: ${record.skillName}`)
  if (typeof record.dir === 'string') lines.push(`dir: ${record.dir}`)
  if (typeof record.path === 'string') lines.push(`path: ${record.path}`)
  if (typeof record.sessionNote === 'string') lines.push(`session: ${record.sessionNote}`)
  if (Array.isArray(record.questions)) {
    lines.push('澄清问题：')
    ;(record.questions as string[]).forEach((question, index) => lines.push(`${index + 1}. ${question}`))
  }
  const extraction = record.extraction as Record<string, unknown> | undefined
  if (extraction !== undefined) {
    for (const field of ['steps', 'tools', 'formats', 'gaps'] as const) {
      const values = extraction[field]
      if (Array.isArray(values) && values.length > 0) lines.push(`${field}: ${(values as string[]).join(', ')}`)
    }
  }
  if (typeof record.mountHint === 'string') lines.push(`\n挂载提示：\n${record.mountHint}`)
  if (typeof record.message === 'string') lines.push(`${record.message}`)
  return lines.join('\n')
}