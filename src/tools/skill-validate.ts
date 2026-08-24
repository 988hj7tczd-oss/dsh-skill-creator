/**
 * skill_validate — validate an existing skill directory: SKILL.md exists,
 * frontmatter parses, name and description present and valid. Returns per-item
 * pass/fail checks (error wording aligned with upstream validate_skill()).
 */

import { makeHostFs } from '../lib/fs-adapter.ts'
import { textBlock, optString, errorResult, type ToolRunContext, type ToolSpec } from '../lib/tool-spec.ts'
import { validateSkillDir } from '../lib/validate-skill.ts'

export const skillValidateTool: ToolSpec = {
  name: 'skill_validate',
  description: 'Validate an existing skill directory: SKILL.md exists, frontmatter parses, name and description are present and valid. Returns per-item pass/fail.',
  parameters: {
    path: { type: 'string', required: true, description: 'Absolute path of the skill directory to validate.' },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string' },
      ok: { type: 'boolean' },
      checks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { item: { type: 'string' }, ok: { type: 'boolean' }, message: { type: 'string' } },
        },
      },
      summary: { type: 'string' },
      message: { type: 'string' },
    },
  },
  render(_args, value) {
    return [textBlock(renderValidateText(value))]
  },
  presentationMeta(_args, value) {
    const record = value as Record<string, unknown>
    return { ok: record.ok === true }
  },
  async run(ctx: ToolRunContext, args: Record<string, unknown>, signal?: AbortSignal) {
    const dir = optString(args, 'path')
    if (dir === undefined) return errorResult('path is required')
    const fs = makeHostFs(ctx, signal)
    const result = await validateSkillDir(fs, dir)
    return {
      ok: result.ok,
      checks: result.checks,
      summary: result.ok ? 'valid skill: all checks passed' : 'validation failed (see checks)',
    }
  },
}

function renderValidateText(value: unknown): string {
  const record = value as Record<string, unknown>
  const lines: string[] = []
  if (record.status === 'error') return `[skill_validate] error: ${String(record.message ?? '')}`
  lines.push(`[skill_validate] ${record.ok === true ? 'OK' : 'FAILED'}`)
  if (Array.isArray(record.checks)) {
    for (const check of record.checks as { item?: unknown; ok?: unknown; message?: unknown }[]) {
      lines.push(`${check.ok === true ? 'PASS' : 'FAIL'} ${String(check.item ?? '')} — ${String(check.message ?? '')}`)
    }
  }
  if (typeof record.summary === 'string') lines.push(record.summary)
  return lines.join('\n')
}