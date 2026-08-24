# PERMISSIONS — dsh-skill-creator 权限与失败边界声明

本文件供 DSH STORE 自动审查与人工复核使用，如实描述插件在运行时
做什么、不做什么，以及失败边界。

## 运行时行为
- **目的**：在 DSH 宿主内创建 / 校验 / 打包 / 改善 SKILL 技能包
  （四个工具：`skill_new`、`skill_validate`、`skill_package`、
  `skill_improve_description`）。
- **读取**：指定技能目录的内容（SKILL.md、frontmatter、引用/模板/脚本，
  用于校验与描述改善）；扫描目录列表来自 `customSkillDirs` 与 `outputDir` 配置。
- **写入**：仅写入技能输出根（`outputDir`，默认 `$DSH_HOME/skills` 或
  `customSkillDirs[0]`）：
  - 新建技能的目录与 `SKILL.md` 等文件；
  - `skill_package` 产出的 `<skillName>.skill`（ZIP）归档到技能父目录或 `outDir`。
  文件写入经宿主 fs（`ctx.fs` 服务可用时优先，目录创建与二进制 `.skill`
  写入回退 Node fs；遵循 DSH「read-before-write」观察策略）。
- **命令执行**：运行时**不** spawn 任何子进程、不执行 shell。
  （仓库 `scripts/quick_validate.py` / `package_skill.py` 仅为开发者命令行
  工具 `pnpm validate:py` / `pnpm pack:py` 使用，插件运行时以 TypeScript
  同构实现替代，不含 Python 调用。）
- **网络**：无。工具源码无 fetch/http 调用。
- **凭据/密钥**：不读取、不写、不转发任何凭据。
- **外部服务**：无。
- **全局资源**：不安装全局包、不修改 DSH 宿主配置之外的内容。

## 依赖
| 依赖 | 用途 | 提供方 |
|---|---|---|
| Node.js ≥ 22.18 | 插件加载与工具执行 | DSH 宿主 |
| @deepseek-ai/cordis / dsh-tools / schemastery | DSH 宿主提供的运行时服务（peer） | DSH 宿主 |

## 文件权限信号说明
- 运行时**不**执行 `chmod`/`chown` 等权限位修改；技能文件以宿主默认权限创建。
- 打包排除 `__pycache__/`、`node_modules/`、`*.pyc`、`.DS_Store`；
  仓库中文件均以普通文件权限提交（644），无 setuid/setgid/sticky 信号。

## 失败边界（结构化，绝不静默）
| 情形 | 行为 |
|---|---|
| 校验失败（frontmatter/结构/参考文件缺失等） | `skill_validate` 返回逐项问题清单；`skill_package` **拒绝打包**未通过校验的技能 |
| 输出根不存在/不可写 | 可读错误（提示 outputDir 或权限） |
| 参数缺失/路径异常 | 结构化错误返回 |
| 操作中止 | AbortSignal 透传（abortIf 检查），中止时明确报错 |

## 与 DSH STORE 契约的关系
- 供应链：运行时依赖全部由 DSH 宿主提供（peer），不随包下载第三方二进制；
  本包内无预编译二进制、无 postinstall 网络行为。
- 生命周期：一次性 Profile 安装/启动/卸载验证步骤与当前证据见
  `docs/store-evidence.md`；真实 Profile 运行证据在装有 DSH 的宿主上执行该文档步骤补全。