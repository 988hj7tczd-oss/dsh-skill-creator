/**
 * Offline smoke test for dsh-skill-creator.
 *
 * Runs against the plain Node host adapter (no Cordis runtime, no npm deps):
 * node tests/smoke.e2e.ts   (Node >= 22.6 with --experimental-strip-types, or
 *                            any Node >= 23.6 which strips types by default)
 *
 * Covers the main paths of all four tools plus the acceptance criteria:
 *   - skill_new                dry-run questions -> confirm writes a skill that
 *                              the runtime provider lists and loads
 *   - skill_validate           missing file / missing frontmatter / invalid
 *                              name / valid samples
 *   - skill_package            exclusion rules in the produced zip; rejection
 *                              of invalid skills
 *   - skill_improve_description proposal preserves original trigger coverage;
 *                              commit writes the frontmatter back
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { nodeHostFs } from '../src/lib/fs-adapter.ts'
import { validateSkillDir } from '../src/lib/validate-skill.ts'
import { packSkillDir } from '../src/lib/package-skill.ts'
import { readZip } from '../src/lib/zip.ts'
import { OutputDirSkillSource } from '../src/lib/provider.ts'
import { extractIntent } from '../src/lib/draft.ts'
import { parseSimpleYaml, splitFrontmatter } from '../src/lib/frontmatter.ts'
import { skillNewTool } from '../src/tools/skill-new.ts'
import { skillValidateTool } from '../src/tools/skill-validate.ts'
import { skillPackageTool } from '../src/tools/skill-package.ts'
import { skillImproveDescriptionTool } from '../src/tools/skill-improve-description.ts'

const fs = nodeHostFs()
const TMP = await mkdtemp(join(tmpdir(), 'dsh-skill-creator-smoke-'))

let assertions = 0

/** Fake tool context: plugin config only; 'fs'/'session' services absent. */
function makeCtx(config: Record<string, unknown> = {}): { get(key: string): unknown } {
  return { get: (key) => (key === 'skill-creator/config' ? config : undefined) }
}

const VALID_FRONTMATTER = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n## Body\nworkflow here\n`

try {
  // ---------------------------------------------------------------- skill_new
  console.log('[1/5] skill_new ...')
  const goal = [
    'Scan markdown files with bash and extract frontmatter names with grep',
    '1. 用 bash 列出目录下所有 .md 文件',
    '2. 用 grep 提取每个文件的 frontmatter name 字段',
    '3. 汇总输出 Markdown 清单到 report.md',
  ].join('\n')

  const extraction = extractIntent(goal)
  assert.deepEqual(extraction.steps.length, 3, 'three numbered steps extracted')
  assert.ok(extraction.tools.includes('bash') && extraction.tools.includes('grep'), 'tools bash/grep extracted')
  assertions += 2

  // dry-run: clarification questions, nothing written
  const dry = await skillNewTool.run(makeCtx(), { goal }, undefined) as Record<string, unknown>
  assert.equal(dry.status, 'needs-confirmation', 'dry-run returns needs-confirmation')
  assert.ok(Array.isArray(dry.questions) && (dry.questions as string[]).length > 0, 'questions present')
  assertions += 2

  // confirm: writes SKILL.md that passes validation and is listable/loadable
  const created = await skillNewTool.run(makeCtx(), { goal, confirm: true, outputDir: TMP }, undefined) as Record<string, unknown>
  assert.equal(created.status, 'created', 'confirm writes the skill')
  const skillName = created.skillName as string
  const skillDir = join(TMP, skillName)
  assert.equal(basename(skillDir), skillName, 'directory named after the skill')
  assertions += 2

  const raw = await fs.readText(join(skillDir, 'SKILL.md'))
  const fm = splitFrontmatter(raw)
  assert.ok(fm !== undefined, 'generated SKILL.md has frontmatter')
  const data = parseSimpleYaml(fm!.yaml)
  assert.equal(data.name, skillName, 'frontmatter name matches the directory')
  assert.equal(typeof data.description, 'string', 'frontmatter description present')
  assert.ok((fm!.body).includes('## Workflow'), 'body contains the workflow section')
  assertions += 4

  const validationNew = await validateSkillDir(fs, skillDir)
  assert.equal(validationNew.ok, true, 'generated skill validates')
  assertions += 1

  // acceptance: the runtime provider (what feeds ctx.skills) lists and loads it
  const source = new OutputDirSkillSource(fs, [TMP])
  const listings = await source.list()
  assert.ok(listings.some((listing) => listing.name === skillName), 'provider lists the new skill')
  const loaded = await source.get(skillName)
  assert.ok(loaded !== undefined && loaded.content.includes('## Workflow'), 'provider loads the skill body')
  assertions += 2

  // ----------------------------------------------------------- skill_validate
  console.log('[2/5] skill_validate ...')
  const emptyDir = join(TMP, 'empty-skill')
  await fs.mkdirp(emptyDir)
  const missingFile = await validateSkillDir(fs, emptyDir)
  assert.equal(missingFile.ok, false, 'missing SKILL.md fails validation')
  assert.match(missingFile.checks[0]!.message, /not found/, 'reports the missing file')
  const missingFileTool = await skillValidateTool.run(makeCtx(), { path: emptyDir }) as Record<string, unknown>
  assert.equal(missingFileTool.ok, false, 'tool reports the missing file')
  assertions += 3

  const noFmDir = join(TMP, 'no-frontmatter')
  await fs.mkdirp(noFmDir)
  await fs.writeText(join(noFmDir, 'SKILL.md'), 'plain markdown without frontmatter\n')
  const noFmRes = await validateSkillDir(fs, noFmDir)
  assert.equal(noFmRes.ok, false, 'missing frontmatter fails validation')
  assert.ok(noFmRes.checks.some((check) => check.message.includes('missing YAML frontmatter')), 'reports missing frontmatter')
  assertions += 2

  const badNameDir = join(TMP, 'bad-name-skill')
  await fs.mkdirp(badNameDir)
  await fs.writeText(join(badNameDir, 'SKILL.md'), VALID_FRONTMATTER('Bad Name', 'desc'))
  const badNameRes = await validateSkillDir(fs, badNameDir)
  assert.equal(badNameRes.ok, false, 'invalid skill name fails validation')
  assert.ok(badNameRes.checks.some((check) => check.message.includes('invalid skill name')), 'reports invalid name')
  assertions += 2

  const okTool = await skillValidateTool.run(makeCtx(), { path: skillDir }) as Record<string, unknown>
  assert.equal(okTool.ok, true, 'valid skill passes via the tool')
  assert.ok(Array.isArray(okTool.checks) && (okTool.checks as unknown[]).length >= 6, 'per-item checks returned')
  assertions += 2

  // ------------------------------------------------------------ skill_package
  console.log('[3/5] skill_package ...')
  const packDir = join(TMP, 'packable-skill')
  await fs.mkdirp(join(packDir, 'sub', 'evals'))
  await fs.mkdirp(join(packDir, 'node_modules', 'dep'))
  await fs.mkdirp(join(packDir, '__pycache__'))
  await fs.writeText(join(packDir, 'SKILL.md'), VALID_FRONTMATTER('packable-skill', 'Use when packaging skills.'))
  await fs.writeText(join(packDir, 'README.md'), 'readme\n')
  await fs.writeText(join(packDir, 'sub', 'helper.md'), 'helper\n')
  await fs.writeText(join(packDir, 'sub', 'evals', 'nested.md'), 'keep me\n')
  await fs.writeText(join(packDir, 'node_modules', 'dep', 'x.js'), 'junk\n')
  await fs.writeText(join(packDir, '__pycache__', 'gen.pyc'), 'junk\n')
  await fs.writeText(join(packDir, 'unused.pyc'), 'junk\n')
  await fs.writeText(join(packDir, '.DS_Store'), 'junk\n')
  await fs.writeText(join(packDir, 'evals', 'case.md'), 'root evals -> exclude\n')

  const packOutDir = join(TMP, 'packed-out')
  const packed = await packSkillDir(fs, packDir, packOutDir)
  assert.equal(packed.ok, true, 'packing succeeds')
  assert.equal(packed.skillName, 'packable-skill', 'zip base name is the skill name')
  assertions += 2

  const zipNames = [...readZip(new Uint8Array(await readFile(packed.outPath))).keys()]
  assert.ok(zipNames.every((name) => name.startsWith('packable-skill/')), 'archive structure is <name>/ + contents')
  for (const expected of ['packable-skill/SKILL.md', 'packable-skill/README.md', 'packable-skill/sub/helper.md', 'packable-skill/sub/evals/nested.md']) {
    assert.ok(zipNames.includes(expected), `archive contains ${expected}`)
  }
  for (const banned of ['node_modules', '__pycache__', '.pyc', '.DS_Store', 'evals/case.md']) {
    assert.ok(!zipNames.some((name) => name.includes(banned)), `archive excludes ${banned}`)
  }
  assertions += 8

  // packaging refuses invalid skills (validation runs first)
  const invalidPack = await skillPackageTool.run(makeCtx(), { path: emptyDir }) as Record<string, unknown>
  assert.equal(invalidPack.ok, false, 'packaging an invalid skill is refused')
  assert.match(String(invalidPack.error), /validation failed/, 'reports the validation failure')
  assertions += 2

  // tool main path for a valid skill
  const packedTool = await skillPackageTool.run(makeCtx(), { path: packDir, outDir: packOutDir }) as Record<string, unknown>
  assert.equal(packedTool.ok, true, 'packaging via the tool succeeds')
  assert.ok(typeof packedTool.outPath === 'string' && packedTool.outPath.endsWith('.skill'), 'tool returns a .skill path')
  assertions += 2

  // ------------------------------------------------- skill_improve_description
  console.log('[4/5] skill_improve_description ...')
  const improvable = join(TMP, 'improvable-skill')
  await fs.mkdirp(improvable)
  await fs.writeText(
    join(improvable, 'SKILL.md'),
    '---\nname: improvable-skill\ndescription: Use when reviewing commit messages before merging pull requests.\n---\nbody\n',
  )
  const usage = 'checking git history for rebase conflicts before squashing merges'
  const proposedTool = await skillImproveDescriptionTool.run(makeCtx(), { path: improvable, usage }) as Record<string, unknown>
  assert.equal(proposedTool.status, 'proposed', 'dry-run returns a proposal')
  assert.ok((proposedTool.preserved as string[]).includes('reviewing'), 'original trigger token preserved')
  const proposed = proposedTool.proposed as string
  assert.ok(proposed.includes('reviewing'), 'proposal contains the original trigger keyword')
  assert.ok(proposed.includes('rebase'), 'proposal adds a scenario keyword')
  // acceptance: the rewrite keeps full original trigger coverage
  for (const token of proposedTool.preserved as string[]) {
    assert.ok(proposed.includes(token), `proposal keeps original token "${token}"`)
  }
  assertions += 5

  const committedTool = await skillImproveDescriptionTool.run(makeCtx(), { path: improvable, usage, commit: true }) as Record<string, unknown>
  assert.equal(committedTool.status, 'committed', 'commit succeeds')
  const afterRaw = await fs.readText(join(improvable, 'SKILL.md'))
  const afterData = parseSimpleYaml(splitFrontmatter(afterRaw)!.yaml)
  assert.equal(afterData.description, proposed, 'frontmatter description updated')
  assert.equal(afterData.name, 'improvable-skill', 'other frontmatter fields untouched')
  assert.ok(afterRaw.includes('body'), 'markdown body untouched')
  const stillValid = await validateSkillDir(fs, improvable)
  assert.equal(stillValid.ok, true, 'skill stays valid after the rewrite commit')
  assertions += 4

  // --------------------------------------------------------- smoke completeness
  console.log('[5/5] notes ...')

  console.log(`\n[smoke] PASS — ${assertions} assertions across 4 tool main paths + acceptance criteria`)
} finally {
  await fs.remove(TMP)
}