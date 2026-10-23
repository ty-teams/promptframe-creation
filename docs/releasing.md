# npm 发布与 GitHub Actions

本仓独立发布 `@promptframe/creation`，不与组件作者四包绑定版本。源码和文档在 GitHub；npm 包提供版本化安装入口。基础版范围见[0.1.0 说明](releases/0.1.0.md)，首次 OIDC 后继版本见[0.1.1 说明](releases/0.1.1.md)。如果包被设为 `private: true`，CI仍可检查安装包，正式发布会明确拒绝；工作流不会自动删除这个字段。

## 日常检查

`.github/workflows/ci.yml` 在 PR、main 更新或手工运行时检查 Node 20/24：锁文件安装、测试、npm 包内容和隔离安装。它不会调用真实平台 setup、模型或媒体服务。以下命令由维护者在源码仓执行：

```bash
npm ci --ignore-scripts
npm test
node scripts/package-release.mjs pack /tmp/creation-package
node scripts/package-release.mjs smoke /tmp/creation-package
```

安装包必须包含运行脚本、Skill、三个隐藏插件入口、README 和 LICENSE；排除测试、工作流、发行脚本及个人配置。隔离安装会从 registry 安装普通依赖并运行 `--help`，只使用临时配置目录。此项不代表特定宿主插件缓存、原生 Windows ACL 或完整创作旅程已经验收。

## npm 安装与宿主插件安装的验证范围

现有 `smoke` 明确执行普通 `npm install`，由 npm 补齐 `package.json.dependencies` 后运行 CLI。Codex 的 npm 来源插件安装在已核[官方实现](https://github.com/openai/codex/blob/de06fd0be4f465bc28c3111bdadaabda5dfdebcd/codex-rs/core-plugins/src/npm_source.rs)中使用 `npm pack --ignore-scripts` 后解包，不执行相同的依赖安装步骤。

当前桥顶层导入 MCP SDK，发布包未携带 node_modules，因此这两条安装路径需要独立核实。交付“从目录安装插件即可运行”时，应先提供包含必要依赖的桥产物，或明确交付并验证完整依赖；不能依赖发布后 lifecycle script、开发者已有 node_modules 或仅以 `--help` 普通安装测试冒宿主冷安装通过。具体源码与验收区分见[开发说明](development.md)。本说明只校准验证范围，不声明已实现该构建产物。

## 一次性发布配置

GitHub 仓库创建 Environment `npm-production`，部署规则只允许 `creation-v*` 标签。无需 npm 长期发布 Token。npm 账号所有者完成新包初始化后，在该包的 Trusted Publisher 页面配置：

| 字段 | 值 |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `ty-teams` |
| Repository | `promptframe-creation` |
| Workflow filename | `publish.yml` |
| Environment | `npm-production` |
| Allowed action | 允许直接 `npm publish`，满足既定自动发行流程 |

首次包初始化需要账号持有者完成 npm 要求的身份验证；登录或 2FA 提示由本人处理。不要将密码、OTP、恢复码或 Token 写进仓库/聊天。npm 新建的信任配置需在两天内完成首次成功发布，因此应在可审核版本就绪时配置。

本仓首次初始化采用：账号持有者授权人工发布可用基础版 0.1.0 → 等官方 registry 确认包可读 → 配置并回读 Trusted Publisher → 用 GitHub OIDC 发布后继 0.1.1。人工首发不冒称 OIDC 发布；后续自动发行不再使用该登录凭据。

官方也支持新包 staged publishing，但不能把 stage、trust 或 reject 的单条成功回执当成包身份与信任会持续存在的保证。本仓初始化时在暂存阶段创建信任后，拒绝唯一候选，随后包与信任读取均返回404；因此不采用“拒绝暂存后直接推标签”的初始化步骤。待审版本与正式版本仍共享版本唯一约束，不可竞争发布同一版本；任何候选撤除后都要重新核包和信任，确认可用再进入自动发行。

## 验证工作流与正式发行

在 GitHub Actions 手工运行 **Publish Creation** 是无发布的检查：测试、打包、隔离安装并保存7天artifact。只有 `creation-v<version>` 标签的 push 能进入正式发布，手工运行不会发布 npm。

正式发行前以一个正常提交完成：`private: false`，同步 package.json、package-lock.json及插件manifest版本，并验证当前版本所承诺的功能。当前流程接受稳定 `X.Y.Z` 版本。将该提交合入 main，再创建匹配标签，例如 `creation-v0.1.1`；无需为测试这套工作流提前推正式标签。

正式tag必须属于 main 历史。打包job没有OIDC权限；通过检查的同一个tgz及manifest传给独立publish job，后者才取得 `id-token: write`。publish job使用Node24自带兼容npm，通过OIDC向官方registry发布public包，禁用脚本并生成provenance。源码commit、包/lock/插件版本、tag及SHA-512 integrity必须一致；不在发布时重新打包。

官方registry最多等待15分钟回读目标版本、integrity和provenance。同版本重跑只观察原版本，匹配才成功，冲突即失败；不会重新发布或把latest倒退到旧版本。超过回读时限须核原版本和扫描状态，不能换版本盲发。npm发行不可当作插件市场上架或平台功能验收完成。

## 维护与故障

- `package_not_ready_private_must_be_false`：包尚未批准为可发行，先完成真实功能和版本提交。
- `release_tag_mismatch` / `version_mismatch`：核正常源码版本与标签，不移动已发布标签或覆盖旧版本。
- npm认证失败：核 npm Trusted Publisher 的四个字段、直接publish权限、GitHub-hosted runner和对应Environment；无需新增长期Token。
- `artifact_integrity_mismatch` / `registry_integrity_conflict`：停止该次发行，核同一个artifact与原版本，不重传不同字节冒充同版。
- npm包发布不变更用户已保存的创作Token，也不自动覆盖活动桥进程。客户端安装/升级与平台接入按README和当版功能说明执行。

官方参考：[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)。
