/**
 * Minimal YAML frontmatter support for SKILL.md files.
 *
 * The module deliberately implements a small, dependency-free YAML subset so
 * the plugin and its offline smoke tests run with zero npm runtime deps while
 * still matching the checks the upstream quick_validate.py performs with
 * PyYAML. Supported subset:
 *
 *   - block mappings keyed at an indent level (`key: value`)
 *   - nested mappings via deeper indentation (used by `metadata:` etc.)
 *   - scalar values: plain, single-quoted, double-quoted, block scalars
 *     (`|`, `>-`, ...) whose content is indented below the key
 *   - booleans / null / numbers and inline flow lists `[a, b, c]`
 *
 * Anything outside the subset either throws {@link YamlError} (validation then
 * reports "invalid YAML frontmatter") or parses conservatively. The Python
 * scripts in scripts/ use PyYAML and remain the authoritative full-spec
 * validator.
 */

export class YamlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'YamlError'
  }
}

export interface FrontmatterSplit {
  /** Raw YAML text between the two `---` fences (no fence lines). */
  readonly yaml: string
  /** Markdown body after the closing fence. */
  readonly body: string
}

const BOOL_TOKENS = new Set(['true', 'false', 'yes', 'no', 'on', 'off'])
const NULL_TOKENS = new Set(['null', '~', ''])

/**
 * Split a raw file into frontmatter (as YAML text) and body. Returns undefined
 * when the file has no `---` header block or no closing fence.
 */
export function splitFrontmatter(raw: string): FrontmatterSplit | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/, '')
  if (firstLine !== '---') return undefined
  let lineStart = firstLineEnd + 1
  let yamlEnd = -1
  while (lineStart <= raw.length) {
    const next = raw.indexOf('\n', lineStart)
    const lineEnd = next < 0 ? raw.length : next
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line === '---') {
      yamlEnd = lineStart
      break
    }
    if (next < 0) return undefined
    lineStart = next + 1
  }
  if (yamlEnd < 0) return undefined
  const closingEnd = raw.indexOf('\n', yamlEnd)
  const bodyStart = closingEnd < 0 ? raw.length : closingEnd + 1
  return {
    yaml: raw.slice(firstLineEnd + 1, yamlEnd),
    body: raw.slice(bodyStart),
  }
}

/** Parse the frontmatter of a raw file, or undefined when absent. */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | undefined {
  const split = splitFrontmatter(raw)
  if (split === undefined) return undefined
  return { data: parseSimpleYaml(split.yaml), body: split.body }
}

/** Find the first top-level `key:` colon position, skipping quoted sections. */
export function findColon(line: string): number {
  let quote: "'" | '"' | undefined
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === ':') return i
  }
  return -1
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed === '' || trimmed.startsWith('#')
}

interface BlockParseState {
  readonly lines: string[]
  index: number
}

function parseBlockMap(state: BlockParseState, indent: number): Record<string, unknown> {
  const map: Record<string, unknown> = {}
  const { lines } = state
  while (state.index < lines.length) {
    const line = lines[state.index]!
    if (isCommentLine(line)) {
      state.index += 1
      continue
    }
    const ind = indentOf(line)
    if (ind < indent) break
    if (ind > indent) {
      // A deeper line without a preceding key: tolerate as an inline continuation.
      state.index += 1
      continue
    }
    const colon = findColon(line)
    if (colon < 0) throw new YamlError(`expected "key: value" at line ${state.index + 1}: ${line}`)
    const key = unquoteScalar(line.slice(ind, colon).trim())
    if (key.length === 0) throw new YamlError(`empty mapping key at line ${state.index + 1}`)
    const rest = line.slice(colon + 1).trim()
    if (rest === '' || rest === '|' || rest === '>' || rest === '|-' || rest === '>-' || rest === '|+' || rest === '>+') {
      const next = lines[state.index + 1]
      const nextIndent = next === undefined ? indent : indentOf(next)
      if (next === undefined || nextIndent <= indent || isCommentLine(lines[state.index + 1] ?? '')) {
        map[key] = null
        state.index += 1
        continue
      }
      if (rest.startsWith('|') || rest.startsWith('>')) {
        map[key] = parseLiteralBlock(state, indent)
        continue
      }
      map[key] = parseBlockMap(state, nextIndent)
      continue
    }
    map[key] = parseScalar(rest)
    state.index += 1
  }
  return map
}

function parseLiteralBlock(state: BlockParseState, parentIndent: number): string {
  const { lines } = state
  const chunks: string[] = []
  state.index += 1 // consume the key line
  while (state.index < lines.length) {
    const line = lines[state.index]!
    if (isCommentLine(line)) {
      state.index += 1
      continue
    }
    const ind = indentOf(line)
    if (ind <= parentIndent) break
    chunks.push(line.slice(parentIndent))
    state.index += 1
  }
  let text = chunks.join('\n')
  // Fold/chomp approximations: trailing blank lines are dropped for '-', kept for '+'.
  text = text.replace(/\n+$/, '')
  return text
}

function parseFlowList(text: string): unknown[] {
  const items: unknown[] = []
  let current = ''
  let quote: "'" | '"' | undefined
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === ',') {
      items.push(parseScalar(current.trim()))
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim().length > 0 || items.length > 0) items.push(parseScalar(current.trim()))
  return items
}

function stripInlineComment(text: string): string {
  // For unquoted scalars, ' #' starts a comment.
  let quote: "'" | '"' | undefined
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === ' ' && text[i + 1] === '#') return text.slice(0, i)
  }
  return text
}

/** Unquote a scalar when it is wrapped in single or double quotes. */
export function unquoteScalar(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  return v
}

/** Parse a scalar value (bool / null / number / quoted / plain string / flow list). */
export function parseScalar(value: string): unknown {
  const v = value.trim()
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1)
    return parseFlowList(inner)
  }
  if (v.startsWith("'") || v.startsWith('"')) return unquoteScalar(v)
  const plain = stripInlineComment(v).trim()
  if (NULL_TOKENS.has(plain.toLowerCase())) return null
  if (BOOL_TOKENS.has(plain.toLowerCase())) {
    return plain === 'true' || plain === 'yes' || plain === 'on'
  }
  if (/^-?(?:\d+)(?:\.\d+)?$/.test(plain)) return Number(plain)
  return plain
}

/** Parse a YAML mapping text into a plain object. Throws {@link YamlError}. */
export function parseSimpleYaml(text: string): Record<string, unknown> {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const state: BlockParseState = { lines, index: 0 }
  const value = parseBlockMap(state, 0)
  return value
}

/**
 * Quote a scalar for emission as a YAML value. Plain-safe tokens emit raw;
 * everything else is single-quoted with '' escaping.
 */
export function quoteYamlScalar(value: string): string {
  if (value.length === 0) return "''"
  const plainSafe = /^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(value)
    && !BOOL_TOKENS.has(value.toLowerCase())
    && !NULL_TOKENS.has(value.toLowerCase())
    && !/^\d/.test(value)
  if (plainSafe) return value
  return `'${value.replace(/'/g, "''")}'`
}

/** Serialize one value as a YAML scalar (flow lists and inline maps supported). */
export function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (Array.isArray(value)) return `[${value.map((item) => yamlScalar(item)).join(', ')}]`
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}: ${yamlScalar(item)}`)
      .join(' ')
  }
  return quoteYamlScalar(String(value))
}

/** Render a complete frontmatter block (with opening and closing `---`). */
export function formatFrontmatter(data: Record<string, unknown>): string {
  const body = Object.entries(data)
    .map(([key, value]) => `${key}: ${yamlScalar(value)}`)
    .join('\n')
  return `---\n${body}\n---\n`
}

/**
 * Replace the value of one top-level frontmatter scalar in place, preserving
 * every other line byte-for-byte (used to commit a rewritten description).
 * Supports replacing plain and block-scalar fields. Returns undefined when the
 * key is not found in the frontmatter.
 */
export function replaceFrontmatterLine(raw: string, key: string, value: string): string | undefined {
  const lines = raw.split('\n')
  let inFrontmatter = false
  let found = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (!inFrontmatter) {
      if (i === 0 && trimmed === '---') {
        inFrontmatter = true
      }
      continue
    }
    if (trimmed === '---') break
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const ind = indentOf(line)
    if (ind > 0) continue
    const colon = findColon(line)
    if (colon < 0) continue
    const currentKey = unquoteScalar(line.slice(ind, colon).trim())
    if (currentKey !== key) continue
    const rest = line.slice(colon + 1).trim()
    const isBlockHeader = rest === '|' || rest === '>' || rest === '|-' || rest === '>-' || rest === '|+' || rest === '>+'
    if (isBlockHeader) {
      let j = i + 1
      while (j < lines.length) {
        const candidate = lines[j]!
        if (isCommentLine(candidate) && indentOf(candidate) <= ind) break
        if (indentOf(candidate) <= ind) break
        if (candidate.trim() === '---') break
        j += 1
      }
      lines.splice(i, j - i, `${' '.repeat(ind)}${key}: ${quoteYamlScalar(value)}`)
    } else {
      lines[i] = `${' '.repeat(ind)}${key}: ${quoteYamlScalar(value)}`
    }
    found = true
    break
  }
  if (!found) return undefined
  return lines.join('\n')
}