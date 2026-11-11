# 客户端与插件开发维护

本仓维护公开创作 Skill、setup、凭据处理、本地 MCP 薄桥和插件声明。平台业务与任务仍由平台 API 执行。开发者先读 AGENTS，确认实际 Git 根、origin、分支和差额，再修改本次任务相关路径。

## 源码路由

| 内容 | 入口 |
| --- | --- |
| 命令和 stdio 桥 | `bin/promptframe-creation.mjs`预检 → `lib/cli.mjs` / `dist/cli.mjs`自包含构建 |
| 用户级安装与profile | `lib/user-installation.mjs` |
| Claude Code 本机入口和插件登记 | `lib/claude-command.mjs`、`lib/claude-installation.mjs` |
| 依赖闭包/许可证 | `scripts/build-runtime.mjs` |
| 环境地址与安全凭据 | `lib/credentials.mjs` |
| 平台 MCP HTTP 连接 | `lib/connection.mjs` |
| 当前源码的宿主 thread 与控制版本接线 | `lib/host-context.mjs` |
| 新会话固定版本选择、完整性缓存与 stdio 接续 | `lib/runtime-bootstrap.mjs`、`lib/runtime-package.mjs`、`lib/runtime-launch.mjs` |
| 插件加载与启动 | `.codex-plugin/plugin.json`、`.mcp.json` |
| 公开视频创作规则 | `skills/video-creation/SKILL.md` |
| 插件目录索引 | `.agents/plugins/marketplace.json` |
| 发行内容、版本约束与同包核验 | `scripts/package-release.mjs`、`.github/workflows/ci.yml`、`.github/workflows/publish.yml` |

打包、版本检查和发行步骤见[发布手册](releasing.md)。

## 三种版本分别核实

1. 当前工作分支的源码 ref 和未提交差额。
2. 已发行 npm 包对应的固定 tag、registry 版本和 integrity/provenance。
3. 用户宿主实际加载的插件缓存、Skill 和 MCP 连接。

已有 `0.1.1` npm 包固定在 `creation-v0.1.1` / `3da232e267117794fcbcbb1920cbdf9f3f294c14`。后续源码即使尚未 bump package 版本，也不属于这个不可变包。文档描述新宿主行为时注明源码范围；真实发行时按[发布手册](releasing.md)同步包/lock/插件版本并使用新标签。

## 安装与运行路径

当前源码的薄桥从平台目录读取工具分类和协议角色，按固定响应元数据管理作品控制版本。Web 或另一聊天编辑时，独立读取仍受项目和素材权限约束；执行与修改需要当前聊天编辑权。工具名称、正文中的同名字段和模型传入的分类都不会授予权限。目录版本变化在后续正常交互中发送标准工具目录变更通知，不额外轮询平台或替换活动进程。

当前源码按平台握手结果提供标准 resources/prompts 读取。项目公开指引复用平台已验证的创作基线；资源 URI 由平台解析，每次读取重新检查账号和项目权限。带版本的引用遇到正文版本变化会提示重新列取，不静默替换内容。桥保留标准正文和元数据，按序列化 UTF-8 计算单块400000字节、整次2000000字节上限；超限不会重执行业务。后续正常读取观察到版本变化时发送对应目录通知，不启动后台轮询。未声明这些能力的平台仍可通过原工具入口读取入门说明。源码能力、公开包和宿主实际支持分别核实。

当前源码在新会话启动时读取平台初始化中的 `experimental.promptframe.creation` 兼容声明。在接收宿主工具调用前，按真实版本检查 `minBridge`，从官方 npm registry 获取固定的 `recommendedBridge`；`--bridge-version X.Y.Z` 可锁定一个兼容版本。下载只允许公开的 `@promptframe/creation` 固定版本，核 SHA-512 integrity、包身份及自包含运行文件后，再原子放入私有缓存。缓存按完整文件摘要复核，同版本不能更换完整性摘要，准备过程不运行安装脚本或注册宿主。新进程继承同一凭据路径和冻结的宿主会话身份，活动桥不被替换。

获取或校验失败时，只有当前程序已经达到已知最低版本才可继续；显式锁定失败不会另选版本。平台缺少兼容声明时提示先更新平台。缓存位于安全凭据目录下的 `runtime-cache`，不会自动删除旧版本或清除不明准备锁。新运行进程启动后的错误不会触发第二次桥启动。

外部宿主可在初始化声明 `experimental.promptframe.contentTypes`，桥只转发已知种类，未声明时使用明确的文字降级。媒体能力来自宿主声明，不从模型或宿主名称推断；真实桌面是否展示图片、音频和资源仍需分别验证。源码、公开包及实际宿主加载分别核实。

`bridge --host codex`使用宿主提供的threadId；`bridge --host claude-code`使用启动环境中的`CLAUDE_CODE_SESSION_ID`。未指定host时，`CLAUDECODE=1`选择Claude Code，其余选择Codex。Claude会话ID缺失时，本进程使用临时UUID；下次启动不能据此保留原编辑身份。无效会话ID会报错，不从调用参数接受替代值。公开发行与两种桌面宿主的实际加载分别核实。

源码经 GitHub Actions 打包发行到 npm；插件目录记录包名/版本或源码位置。安装后，Codex 加载本地副本并按配置启动 Node 桥；桥通过 stdio 接收调用，读取独立安全配置，再通过 HTTPS MCP 连接所选平台。GitHub、npm 与目录索引负责获取版本，不进入正常工具调用链。Token 不进入源码、插件包或命令参数。

当前公开目录固定npm来源；`connect`复用来源和缓存定义可核的已启用官方npm插件；尚未注册时才准备用户级受管版本。受管身份按installation记录和原MCP定义核实，允许安装器Node路径变化，不将未知同名手工入口当作自身安装。`scripts/build-runtime.mjs`显式bundle MCP SDK及必要依赖，拒绝除Node builtins之外的外部import并附第三方许可证。npm_source仍只pack/unpack，不执行npm install；因此`test/package-runtime.test.mjs`从无node_modules解包核可运行。宿主注册/实际Skill及MCP启动另核，普通npm install不代替。

## 相称验证

- 普通源码检查使用本仓 `npm ci --ignore-scripts`、`npm test` 和[发布手册](releasing.md)的 pack/smoke；测试使用临时配置目录。
- 修改宿主接线时核实际宿主元数据、缺失身份和多聊天隔离，不要求模型记忆身份字段；源码控制与真实宿主旅程分别记录。
- 修改插件内容或安装流程时，从无既有依赖/凭据污染的目标环境核 manifest、Skill、桥启动和平台连接；保持现有有效凭据，升级不默认轮换 Token。
- 普通打包/文档检查不调用真实平台 setup、生成媒体或模型。接入和创作测试使用独立测试账号，并遵守平台的项目权限与用量限制。
- 文档调整无需单独增加包版本。分别记录包检查、发行、宿主安装和创作测试结果。

## 公开范围

使用说明保持公开且可移植。平台私有配置、真实端点默认值、用户样本、Token、内部资料和业务权限实现不进入本仓。组件创作需要的工具按 README 指向独立 authoring 仓；不在本仓维护第二套组件 CLI 参数手册或四包发行流程。

安装器比较 connect 的固定目标版本与已安装版本：同版复用、较新版不降级，受管旧版使用独立目录升级。官方 npm 插件为旧版时，会提示升级；Codex 0.160 升级时会删除旧缓存，因此安装器不会自动执行该操作。两种安装方式都会检查启动 Node 和包版本。安装结果包含 requestedVersion/versionStatus；错误信息仅包含版本、动作和处理指引，不输出宿主原始错误、环境或凭据。

安装发现使用 `$CODEX_HOME/config.toml` 的结构化插件登记 ID、`codex plugin marketplace list --json` 的本地根索引、有界目录 JSON 和 `plugin list --marketplace <name> --json`。TOML 使用随运行文件打包的成熟解析器，只保留相关插件身份；目录条目删除后仍查询原登记，读面无法解析该登记就保持 unknown。覆盖全部相关入口，不把不可读目录当未安装，也不调用必需全量远端插件查询。注册前持久保存 pending 登记；注册请求未确认时先查询该登记状态，确认前不重复 add 或回退旧登记。测试从 pack 的实际 npx/connect 入口核隔离配置、两个 profile、并发和失 ACK，不读个人配置。

宿主插件已安装/启用、平台连接验证与聊天加载分别报告。外部安装器不接私有 app-server 生产刷新通道；当前使用官方新聊天/新 session 路径，选择 Local 和独立非 Git 目录即可。候选包、公共 registry 固定包和真实宿主新聊天工具/两个 Skill 的验收分开记录。

Claude Code 使用官方 `plugin list --json` 与 `plugin marketplace list --json` 读取登记，不调用会健康检查 MCP 的 `mcp list/get`。本地 marketplace 的 `readFromFolder/folderVersion` 表示实际读取目录，与安装记录的缓存路径分别核对；版本目录及两份 MCP 定义均验证摘要。每个登记写前保存阶段，回程未知后只观察原身份。隔离 CLI 安装不等于桌面模型会话加载。
