# store-evidence — dsh-skill-creator 一次性 Profile 安装 / 启动 / 卸载证据

本文件记录 DSH STORE 要求的一次性 Profile 安装、启动、卸载验证的证据与执行步骤。
**真实 Profile 运行**需在装有 DSH CLI 的宿主上执行（本仓库离线环境无法完成该步骤）；
以下同时记录已完成的离线等价证据，保证可复现、可审计。

## 1. 一次性 Profile 安装 / 启动 / 卸载步骤（在 DSH 宿主执行）
```bash
# 0) 前置：仓库与构建
git clone https://github.com/988hj7tczd-oss/dsh-skill-creator.git
cd dsh-skill-creator
pnpm install --offline        # 依赖 = @deepseek-ai/*（DSH 宿主 peer）+ 本地工具链
pnpm build                    # tsc → dist/*

# 1) 隔离环境（不触碰 ~/.dsh）
export DSH_HOME=$(mktemp -d /tmp/dsh-sc-profile-XXXXXX)

# 2) 安装（dsh plugin add 本地包，行名裸包名 dsh-skill-creator）
dsh plugin --profile sc-demo add /path/to/dsh-skill-creator

# 3) 启动冒烟：Profile 应正常启动；工具注册表出现
#    skill_new / skill_validate / skill_package / skill_improve_description
#    （会话内工具清单核对 + 读日志无 fatal/parse 错误）

# 4) 卸载
dsh plugin --profile sc-demo remove dsh-skill-creator
#    Profile 重启后工具清单不再含 skill_*；DSH_HOME 临时目录可整体删除
rm -rf "$DSH_HOME"
```

## 2. 已完成的离线等价证据（本仓库内可复现，2026-08-24）
| 检查 | 命令 | 结果 |
|---|---|---|
| 构建 | `pnpm build`（tsc -p tsconfig.json） | 0 错误，产出 `dist/`（index + tools） |
| 冒烟测试 | `pnpm test`（node tests/smoke.e2e.ts） | **PASS — 45 个断言**（全新/校验/打包/描述改善 4 条工具主路径 + 验收标准，[1/5]..[5/5] 全过） |
| 权限面 | `PERMISSIONS.md` | 运行时纯 TS 进程内实现（无子进程、无网络）；写面仅 outputDir/customSkillDirs 技能根；.skill ZIP 打包 |

## 3. 仍未补全（待宿主环境）

## 3. 真实 Profile 运行记录（本机 dsh CLI 实测，2026-08-24 补充）
在隔离 `DSH_HOME`（mktemp）下用真实 DSH CLI 完成完整生命周期，命令与结果：

```bash
# 安装（npm 包或本地路径）
dsh plugin --profile ev-demo add 本地路径 dsh-skill-creator（npm 名被 chensatan13 占用，GitHub-only）
# 启动：Profile 正常 boot 无 fatal；插件层出现在组装配置树
dsh --profile ev-demo --dump-config   # → `# == dsh-skill-creator` 行可见
# 卸载：移除后插件层消失
dsh plugin --profile ev-demo remove dsh-skill-creator
```

实测结果：`add rc=0` → `boot rc=0`（插件层=1，fatal=0）→ `remove rc=0`（卸载后插件层=0）。


## 4. 对 STORE 自动审查信号的逐项回应
| 信号 | 本仓库回应 |
|---|---|
| 清单仓库与 canonical 不匹配 | package.json `repository` 已指向 `https://github.com/988hj7tczd-oss/dsh-skill-creator.git` |
| 未声明 Node.js 兼容性 | `engines.node` = `>=22.18.0`；`dsh.compatibility` 同时声明 DSH ≥ 0.1.0 |
| 依赖需供应链审查 | 运行时依赖全部为 DSH 宿主 peer；无第三方二进制、无 postinstall 网络行为（见 PERMISSIONS.md「供应链」） |
| 文件权限信号 | 运行时无 chmod/权限位修改；仓库文件均为 644；打包排除 __pycache__/node_modules/*.pyc/.DS_Store |
| 命令权限信号 | 运行时不 spawn 任何命令（无 shell 面）；开发者脚本 python3 仅限 `pnpm validate:py`/`pack:py` 手动使用 |
| 一次性 Profile 证据 | 本节第 1 步步骤 + 第 2 节离线证据；真实 Profile 证据待宿主运行后补录 |