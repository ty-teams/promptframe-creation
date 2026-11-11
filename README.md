# PromptFrame Creation

在 Codex 或 Claude Code 中使用自己的推理，使用 PromptFrame 共用视频工具、作品、素材和持久任务，并与 Studio 接续同一作品。本仓是公开插件与薄桥；业务、权限、预算和账务由平台管理。

## 安装和连接

需要 Node.js 20+，以及支持插件的 Codex（最低0.160.0）或 Claude Code（最低2.0.12，提供结构化插件命令）。在 Studio 的“连接与授权”复制当前环境 API 地址，然后在本机终端执行：

<!-- creation-install-command -->
```bash
npx --yes @promptframe/creation@0.3.0 connect --endpoint <Studio提供的API地址>
```
<!-- /creation-install-command -->

Claude Code 使用同一安装入口并加 `--host claude-code`；桌面版远程连接 WSL 时在同一 WSL 执行。每次从 Studio 获取当前固定推荐版本；入口比较已安装版本，较新版本保留，不后台追踪 latest。入口检查环境、准备用户级版本、注册并核回 Codex 插件，复用有效凭据；首次 Token 在终端隐藏输入，不粘进聊天。完成后在同一主机开始新聊天：Codex 使用 **Local 新聊天**（CLI 开新 session），Claude Code 使用新 session。确认 `creation-setup`、`video-creation` 与 MCP 工具一起加载。可以选择独立的非 Git 创作目录，不需要产品源码或 Worktree；不必重新安装或获取 Token。安装本身不接管作品、不启动付费制作。`npx` 单独运行或目录连通不等于当前聊天已加载插件。

[0.2.7](docs/releases/0.2.7.md)支持在 Studio 或另一聊天编辑作品时读取平台用量；[0.2.6](docs/releases/0.2.6.md)统一安装指令的版本和固定 Git 来源诊断；[0.2.5](docs/releases/0.2.5.md)新增项目只读入门和 Skill 说明读取。安装版本以 Studio 的固定推荐为准，已安装的较新版本不会降级。0.2.4 的安装发现、登记异常处理和新聊天指引见[版本说明](docs/releases/0.2.4.md)。

API 使用 Studio 实际可达 origin 和 `/api` 或 `/api/mcp`，没有内置生产/私有地址。远程客户端不要改成自己的 localhost。另一个环境或账号显式使用 `--profile <名称>`；新旧桥各固定凭据路径，不热切环境。有效 Token 不因升级、新作品或接管轮换。详细安装、升级保旧、卸载和排障见[安装说明](docs/installing.md)。Linux、WSL、macOS 使用0700目录/0600凭据；原生Windows ACL尚未验证。

## 源码、包和宿主范围

[0.3.0](docs/releases/0.3.0.md)增加 Claude Code 接入、平台动态工具发现、标准内容与版本化指引，以及新会话的兼容版本选择。已有0.2.x插件保持其安装来源；升级和新会话加载见[安装说明](docs/installing.md#claude-code接入)。

| 版本或层次 | 适用范围 |
| --- | --- |
| 历史 npm0.1.1 / creation-v0.1.1 | 固定3da232e267117794fcbcbb1920cbdf9f3f294c14的基础setup/status/bridge；不是此版的聊天身份和插件安装功能 |
| 0.2.3源码与包合同 | 宿主thread隔离、桥管理控制版本、自包含运行依赖、用户级安装/两类Skill/独立profile；是否已发行以registry和固定tag为准 |
| 实际用户宿主 | 核已安装版本、Skill加载与MCP连接；源码提交或npm发行不代替宿主及完整创作验收 |

公开目录 `.agents/plugins/marketplace.json` 固定 npm 包版本。用户级 connect 从当前完整包注册受管本地副本；两条路径都携带运行依赖，不要求在业务仓安装SDK。不要同时启用旧的手工MCP入口和新插件；旧入口识别与安全迁移见安装说明。

## 维护入口

维护源码先读 AGENTS 和[开发说明](docs/development.md)。在本仓开发：

```bash
npm ci --ignore-scripts
npm run build
node bin/promptframe-creation.mjs connect --endpoint <Studio提供的API地址>
npm test
```

开发构建显式产生自包含运行文件。`npm pack --ignore-scripts` 的发行准备由[发布脚本](docs/releasing.md)显式执行构建，不依赖宿主执行安装脚本。不要把源码仓或其node_modules复制给最终用户。

## 用组件丰富视频内容

外部创作 Agent 可以复用平台中的组件，也可以按需开发新组件，例如机制动态图解、对比视图和可参数化图表。先从 MCP 当前工具目录发现组件检索与 schema 读取能力，选择已可用的组件并按 schema 填充 props，使用平台返回的 `componentRef`。CLI 的 `discovery` 用于查看端点能力，`component list` 用于查看项目声明；它们不等于组件市场搜索。

需要新组件时，按需阅读独立的 [组件作者仓库与入门说明](https://github.com/ty-teams/promptframe-component-authoring#readme)、[组件创作 Skill](https://github.com/ty-teams/promptframe-component-authoring/blob/main/skills/component-authoring/SKILL.md) 和 [Authoring Guide](https://github.com/ty-teams/promptframe-component-authoring/blob/main/AUTHORING.md)。公开工具包为：

| 工具包 | 用途 |
| --- | --- |
| [`@promptframe/cli`](https://www.npmjs.com/package/@promptframe/cli) | `promptframe` 命令：检查、预览、打包、上传和查询平台构建状态；[CLI 使用说明](https://github.com/ty-teams/promptframe-component-authoring/blob/main/packages/cli/README.md) |
| [`create-promptframe-component`](https://www.npmjs.com/package/create-promptframe-component) | 创建组件项目与本地预览入口 |
| [`@promptframe/component-kit`](https://www.npmjs.com/package/@promptframe/component-kit) | 组件布局、时序和预览等开发辅助能力 |
| [`@promptframe/contracts`](https://www.npmjs.com/package/@promptframe/contracts) | 平台公开组件合同与标准 |

组件开发放在独立的作者项目中，仅在需要时安装这些工具；单纯连接 MCP 不要求预装组件工具链。按当前公开文档和平台标准选择兼容版本，完成本地检查、预览、打包与上传后，再读取平台构建/审核及可用状态。上传受理不等于已可用于作品；可用后重新从平台读取组件身份、版本与 schema，再写入 VideoSpec。npm 包名、本地路径或原始脚本 URL 都不能替代 `componentRef`。

组件 CLI 的端点由该部署提供，按 CLI 的登录与项目说明单独配置；不要将创作 MCP 地址直接当作 CLI 地址。组件上传授权与本仓创作 Token 用途不同。可复用组件遵循 `marketplace_authoring`，仅供当前项目的组件遵循 `project_private_generation`，并以平台实际授权为准；本地写代码或上传组件不会代替平台的制作确认。

## 创作与宿主身份

video-creation Skill 通过平台目录和 schema 发现可用能力，访问当前账号有权使用的作品。编辑已有作品前，需要在 Studio 确认编辑权；只有用户要求时才新建作品。已受理的异步任务会继续运行，客户端停止等待不会取消任务。暂时无法确认结果时，可通过任务 ID 查询状态，避免重复生成。

受支持的 Codex 会在 MCP 元数据中提供 threadId。桥与平台结合环境、账号、安装和聊天身份区分编辑者；身份不完整时，不能新建或编辑作品，已受理任务的状态查询仍可使用。桥管理聊天的 controlVersion，作品修改使用 expectedRevision 检查并发冲突。受支持的只读工具使用平台返回的作品控制版本，并由服务端工具注册表和白名单共同验证；读取权限不会授予编辑权。

Token是独立创作授权，不是codex mcp login。已有有效文件会复用；网络失败不自动替换。平台历史与用量记录覆盖经平台接收的请求；外部聊天、本地文件和本地推理不会自动计入。原生 Windows 的文件权限及其它宿主兼容性仍需单独验证。

GitHub Actions沿独立版本和既有OIDC流程发行；普通main只跑CI。包/lock/plugin版本一致，正式新版本用新的creation-v标签，已发布的版本和标签保持不变。详见[发布手册](docs/releasing.md)。
