/**
 * Dependency-free tool specification shared by the four skill-creator tools.
 *
 * Plain data + a `run(ctx, args, signal)` main path means the tools can be
 * exercised by offline smoke tests without a Cordis runtime; `src/index.ts`
 * adapts each spec into a `defineTool` definition.
 */

export type ContentTextBlock = { type: 'text'; text: string }

export interface ToolParameterSpec {
  type: string
  required?: true
  description?: string
  default?: string | number | boolean
}

export interface ToolPropertySpec {
  type: string
  description?: string
  items?: ToolPropertySpec
  properties?: Record<string, ToolPropertySpec>
  additionalProperties?: boolean
}

export interface ToolOutputSchemaSpec {
  type: 'object'
  description?: string
  properties: Record<string, ToolPropertySpec>
  additionalProperties: boolean
}

/** Minimal context surface tools read. `get` mirrors cordis `ctx.get`. */
export interface ToolRunContext {
  get(name: string): unknown
}

export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, ToolParameterSpec>
  readonly outputSchema: ToolOutputSchemaSpec
  render(args: Record<string, unknown>, value: unknown): ContentTextBlock[]
  presentationMeta?(args: Record<string, unknown>, value: unknown): Record<string, unknown>
  run(ctx: ToolRunContext, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
}

/** Build one model-visible text content block. */
export function textBlock(text: string): ContentTextBlock {
  return { type: 'text', text }
}

/** Read an optional string parameter, trimmed; returns undefined for empty. */
export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Read an optional boolean parameter. */
export function optBool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = args[key]
  return typeof value === 'boolean' ? value : fallback
}

export interface RunError {
  status: 'error'
  message: string
}

export function errorResult(message: string): RunError {
  return { status: 'error', message }
}