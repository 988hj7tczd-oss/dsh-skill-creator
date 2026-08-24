# dsh-skill-creator

> [!IMPORTANT]
> **依赖前置：相邻 `dsh-src` 检出（`link:` 依赖）**
> 本项目在开发形态下使用 `link:` 依赖指向相邻的 DeepSeek Harness 源码检出（`dsh-src`），
> 与当前仓库保持同一父目录布局（`<parent>/dsh-src`）。克隆本仓库后：
> 1. 先把官方 `deepseek-ai/deepseek-harness` 检出到与本仓库同级的 `dsh-src/` 目录，并执行其 `pnpm install && pnpm run build`；
> 2. 再按下方「安装」一节执行本仓库的 `pnpm install --offline && pnpm build` 与测试。
> 发布到 npm 的版本会尽量把 `link:` 依赖替换为 registry 真实版本；无法替换的内部包保持 `link:`，见各包 README 说明。


一键生成 DSH 技能（SKILL.md）的 Cordis 插件：在 DeepSeek Harness 会话内，从一段对话/一份文档/一个流程描述自动生成符合 DSH 技能格式的 `SKILL.md`，并支持**校验、打包分发、描述优化**。

> 参考与许可：功能与流程参考 anthropics/claude-plugins-official 的 `skill-creator`（其源码为 Proprietary），本项目**仅移植行为与规则，代码独立重写**；脚本与逻辑见下方"从上游移植的内容"。本项目采用 [MIT](./LICENSE)。

---

## 1. 安装与挂载

本项目是一个 **DSH bundle**（组合包）：`package.json` 通过 `dsh.bundle.patch` 指向 `cordis.yml`，`cordis.yml` 插入一行 `skill-creator` 插件。

```sh
# 在项目目录同级安装（dsh CLI）
dsh plugin --profile <name> add ./dsh-skill-creator
# 或直接加载本地元数据层
dsh --profile <name> --patch ./cordis.yml
```

`cordis.yml` 插件行可配置（均可省略）：

```yaml
- insert:
    - id: skill-creator
      name: 'dsh-skill-creator'
      config:
        mountRuntimeProvider: true   # 是否把输出目录注册为运行期技能源
        # outputDir: /abs/path       # 技能输出根；默认 $DSH_HOME/skills
        # customSkillDirs: [...]     # 附加根；默认输出目录取首项
```

### 插件行为

- **4 个模型工具**通过 `defineTool` 注册（`tools` 服务，effect 式注册，卸载自动清理）。
- **自带"输出目录挂载"**：`apply` 时若 `skills` 注册表可用，将输出根（`outputDir` + `customSkillDirs`）注册为一个运行期 skill provider（`registerProvider`，rank 300 / source `custom`），因此 `skill_new` 写出的技能立即能被 `skill` 工具列出并加载，无需手工改配置。
- 若注册表不可用（未安装 `@deepseek-ai/dsh-skill`），插件在日志与 `skill_new` 返回里给出 **mountHint**：在 profile 的 `skill-filesystem` 配置中增加 `customSkillDirs`。

构建与测试：

```sh
pnpm install && pnpm build      # tsc → dist/（rewrite .ts → .js）
node tests/smoke.e2e.ts         # 离线冒烟测试（无外部依赖）
```

> 依赖说明：仅有 `src/index.ts` 引用 `@deepseek-ai/cordis`（仅类型）与 `@deepseek-ai/dsh-tools`。`src/lib`、`src/tools` 全部零 npm 依赖（只用 Node 内置模块），因此冒烟测试、Python 脚本与静态阅读均可在离线环境完成。

---

## 2. 四个工具

### 2.1 `skill_new` — 捕获意图生成草稿

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `goal` | string (必填) | 要固化成技能的工作流描述：步骤、工具、输入/输出格式、边界 |
| `fromSession` | boolean | 尽力从当前会话历史抽取上下文（session 服务不可用时降级） |
| `name` / `description` | string | 可选覆盖；默认由 goal 生成 |
| `outputDir` | string | 输出根；默认 `插件 config.outputDir` → `customSkillDirs[0]` → `$DSH_HOME/skills` |
| `confirm` | boolean | `false`（默认）= 干跑：返回意图抽取 + 澄清问题，不写盘；`true` = 写盘 |

流程（对齐上游 Capture Intent 迭代闭环的第 1–2 步）：

1. `confirm=false` 干跑 → 返回从 goal / 会话抽取的 `steps / tools / formats / gaps` 与**澄清问题**（缺口处让用户补）；
2. 确认后 `confirm=true` → 生成 `SKILL.md`（frontmatter `name` + `description` + 正文结构：**Workflow / Inputs and outputs / Boundaries / Example**）并写入，同时返回挂载提示。

写盘遵守 DSH 读改写策略：覆盖已存在文件前先读取（见 `src/lib/fs-adapter.ts` 的 `serviceHostFs.writeText`）。

### 2.2 `skill_validate` — 校验已有技能目录

参数 `path`（必填）。逐项 PASS/FAIL 检查（报错文案对齐上游 `validate_skill()`）：

1. `SKILL.md exists` — 文件必须存在；
2. `SKILL.md readable` — 可读；
3. `frontmatter` — 必须有 `--- ... ---` 且能解析为 YAML mapping；
4. `name` / `description` — 必须为非空字符串；
5. `name` — 必须匹配 DSH kebab-case 命名 `^[a-z0-9]+(?:-[a-z0-9]+)*$`；
6. `body` — 正文非空（信息性检查）。

返回：`{ ok, checks: [{ item, ok, message }], summary }`。

### 2.3 `skill_package` — 打包 `.skill`（zip）

参数：`path`（必填）、`outDir`（可选，默认技能目录的父目录）。**打包前先跑 `skill_validate`，校验失败拒绝打包。**

排除规则（移植自上游 `package_skill.py`）：`__pycache__/`、`node_modules/`（任意深度）、`*.pyc`（任意深度）、`.DS_Store`（任意深度）、技能根级 `evals/`（仅根级；深层 `evals` 保留）。

产物结构：`<skill-name>/ + 内容`，输出 `<outDir>/<skill-name>.skill`。zip 使用 store 方式（`src/lib/zip.ts` 内建最小 ZIP 读写，零依赖，便于离线测试与验证）。

### 2.4 `skill_improve_description` — 改写 description 提高触发率

参数：`path`（必填）、`usage`（必填，触发场景样例）、`commit`（默认 `false`）。

- `commit=false`：返回改写稿 `proposed` + 逐条 `reasons` + `preserved`（保留的原始触发词）/ `added`（新增场景词）。改写引擎**保留原始触发场景覆盖**（每个原始触发词仍出现在改写稿中）。
- `commit=true`：把审核通过的改写稿写回 SKILL.md 的 frontmatter `description`（仅替换该行，其余字段与正文逐字节不变；写回前先读取）。

配合 DSH 常规交互：模型先拿提案给用户确认，再以 `commit=true` 落盘。

---

## 3. 目录与交付物

```
dsh-skill-creator/
├── cordis.yml                  # bundle 层：插入 skill-creator 插件行
├── package.json                # dsh.bundle 清单（patch: ./cordis.yml）
├── tsconfig.json               # TypeScript 构建配置（rewrite .ts → .js）
├── LICENSE                     # MIT
├── src/
│   ├── index.ts                # 插件装配：声明 Config/apply，注册 4 工具 + 输出目录挂载
│   ├── tools/
│   │   ├── skill-new.ts
│   │   ├── skill-validate.ts
│   │   ├── skill-package.ts
│   │   └── skill-improve-description.ts
│   └── lib/                    # 零依赖核心（工具与冒烟测试共用）
│       ├── skill-name.ts       # kebab-case 校验与 slug
│       ├── frontmatter.ts      # 最小 YAML frontmatter 解析/生成/字段原地替换
│       ├── fs-adapter.ts       # HostFs：ctx.fs 服务优先，回退 Node；写前先读
│       ├── tool-spec.ts        # 工具规格类型（defineTool 适配层）
│       ├── validate-skill.ts   # skill_validate 核心
│       ├── zip.ts              # 最小 ZIP 读写（store + CRC-32）
│       ├── package-skill.ts    # skill_package 核心（排除规则）
│       ├── draft.ts            # skill_new 核心（意图抽取/澄清问题/草稿生成）
│       ├── improve.ts          # skill_improve_description 核心（改写+提交）
│       ├── provider.ts         # 输出目录运行期 skill provider（挂载机制）
│       └── tool-env.ts         # 输出根解析、mountHint、会话尾部抽取
├── scripts/
│   ├── quick_validate.py       # 移植自上游 quick_validate.py 的校验规则（PyYAML，权威校验）
│   └── package_skill.py        # 移植自上游 package_skill.py 的打包规则（zipfile）
├── tests/
│   └── smoke.e2e.ts            # 离线冒烟测试：4 个工具主路径 + 验收标准
└── README.md
```

TS 侧校验器 `src/lib/frontmatter.ts` 实现的是**文档化 YAML 子集**（块映射、嵌套缩进、引号标量、块标量、行内列表等），与 `scripts/quick_validate.py`（PyYAML 全量解析）检查项一致、互为印证；生成文件只使用该子集，故两者判定等价。

---

## 4. 验收标准对照

| 验收标准 | 落实位置 |
| --- | --- |
| 1. 生成技能可被 `ctx.skills` 列出并加载 | `skill_new` 写盘 → 运行期 provider（`lib/provider.ts`）暴露给 `skills` 注册表；冒烟测试用 `OutputDirSkillSource.list()/get()` 验证 |
| 2. `skill_validate` 对三类样本正确判定 | `lib/validate-skill.ts` + 冒烟测试（缺文件/缺 frontmatter/非法名/正常） |
| 3. 打包 zip 不含排除项、结构 = 技能名/ + 内容 | `lib/package-skill.ts` + `scripts/package_skill.py`；冒烟测试用内建 zip 读取回验，Python 侧用 `unzip -l` 验证 |
| 4. 改写保留原始触发场景覆盖 | `lib/improve.ts`（`preserved ⊆ proposed`）+ 冒烟测试逐词断言 |
| 5. 冒烟测试覆盖 4 工具主路径 | `tests/smoke.e2e.ts`（45 条断言，离线通过） |

---

## 5. 运维与限制

- **最小 YAML 子集**：`src/lib/frontmatter.ts` 不解析复杂 YAML（锚点、多文档、嵌套序列等会报 `invalid YAML frontmatter` 或保守解析）。权威校验以 `scripts/quick_validate.py`（PyYAML）为准。
- **挂载优先级**：运行期 provider 的 rank=300（custom 层），项目根（rank 100/200）同名技能优先；与技能注册表默认行为一致。
- **二进制写盘**：`.skill` 产物与目录创建走 Node（fs 服务为文本只写）；若部署环境限制插件写盘，请把 `outputDir` 指向允许的路径并配置 `skill-filesystem.customSkillDirs`。
- **fromSession** 为尽力而为：读取不到 session 服务时仅按 `goal` 抽取并在结果中注明。
- **model 改写**：本版本描述改写使用确定性规则引擎（离线可测、可复现）；对更强的语义改写，可在 `src/lib/improve.ts` 中注入模型完成器（当前不引入 LLM 运行时依赖）。

---

## 6. 上游移植说明

| 上游（Proprietary） | 本项目（MIT） |
| --- | --- |
| `scripts/quick_validate.py` 校验规则与报错风格 | `scripts/quick_validate.py`（重写）+ `src/lib/validate-skill.ts`（TS 移植） |
| `scripts/package_skill.py` 排除规则与"先校验后打包" | `scripts/package_skill.py`（重写）+ `src/lib/package-skill.ts`（TS 移植） |
| Capture Intent（步骤/工具/格式抽取 + 澄清问题） | `src/lib/draft.ts`（确定性启发式，行为对齐） |
| `improve_description.py` description 优化 | `src/lib/improve.ts`（保留触发覆盖的改写引擎） |
| 迭代闭环（草稿→测试→评估→重写） | 由使用方（会话中的模型）通过 4 个工具编排复现 |

`src/lib/zip.ts`、`src/lib/frontmatter.ts`、`src/lib/fs-adapter.ts`、`src/lib/provider.ts` 为本项目新增实现（无上游对应源码）。

## 权限、失败边界与 DSH STORE 状态

- [PERMISSIONS.md](./PERMISSIONS.md)：运行时读取面 / 命令面（固定 argv，非 shell）/ 写面 / 外部服务 / 失败边界 / 供应链 / 文件权限信号（无 chmod/chown、644、无 setuid/setgid）。
- [docs/store-evidence.md](./docs/store-evidence.md)：一次性 Profile 安装 → 启动（工具注册清单）→ 卸载步骤、本地离线证据、待宿主补录真实运行记录说明，并逐项回应 DSH STORE 五类审查信号（仓库 canonical 匹配 / Node 声明 / 供应链 / 文件权限 / 命令权限）。
- STORE 复检由 dsh-safe-plugin-manager 每 3 小时自动执行；本仓库已按清单契约声明（package.json 的 `repository` / `engines.node` / `dsh.compatibility` / `dsh.permissions`）。
