# PromptFrame Creation

通过自己的 Codex 推理，使用 PromptFrame 共用视频工具、作品、素材和持久任务，并与 Studio 接续同一作品。本仓是公开插件与薄桥；业务、权限、预算和账务由平台管理。

## 安装和连接

需要 Node.js 20+ 及支持插件的 Codex（最低0.160.0）。在 Studio 的“连接与授权”复制当前环境 API 地址，然后在本机终端执行：

```bash
npx --yes @promptframe/creation@0.2.1 connect --endpoint <Studio提供的API地址>
```

入口检查环境、准备用户级版本、注册并核回 Codex 插件，复用有效凭据；首次 Token 在终端隐藏输入，不粘进聊天。完成后按提示正常重载插件或开新聊天，确认 `creation-setup`、`video-creation` 与 MCP 工具一起加载。安装本身不接管作品、不启动付费制作。`npx` 单独运行或目录连通不等于当前聊天已加载插件。

API 使用 Studio 实际可达 origin 和 `/api` 或 `/api/mcp`，没有内置生产/私有地址。远程客户端不要改成自己的 localhost。另一个环境或账号显式使用 `--profile <名称>`；新旧桥各固定凭据路径，不热切环境。有效 Token 不因升级、新作品或接管轮换。详细安装、升级保旧、卸载和排障见[安装说明](docs/installing.md)。Linux、WSL、macOS 使用0700目录/0600凭据；原生Windows ACL尚未验证。

## 源码、包和宿主范围

| 版本或层次 | 适用范围 |
| --- | --- |
| 历史 npm0.1.1 / creation-v0.1.1 | 固定3da232e267117794fcbcbb1920cbdf9f3f294c14的基础setup/status/bridge；不是此版的聊天身份和插件安装功能 |
| 0.2.1源码与包合同 | 宿主thread隔离、桥管理控制版本、自包含运行依赖、用户级安装/两类Skill/独立profile；是否已发行以registry和固定tag为准 |
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

video-creation Skill 先动态发现平台目录/schema，选择用户有权的作品和能力；已有作品需正常申请编辑权并由本人在 Studio 确认。新建空作品沿明确用户意图，不覆盖第一作品。已接受异步任务持久存在，客户端停止等待不取消订单；结果未知先观察原 task，不重派生成或补造回执。

受支持 Codex 在 MCP 元数据中自动提供 threadId。桥与平台结合环境、账号、安装和该thread区分编辑者；缺失身份拒绝新建/接管/新写，不退回共享编辑身份。原已接受任务的只读观察仍保留。桥管理本线程已批准的controlVersion，作品expectedRevision仍按原并发合同，不替模型追最新内容版本。四个内置只读候选使用真实同scope版本，服务仍以当前registry及白名单双核；不借读权缓存成编辑权。

Token是独立创作授权，不是codex mcp login。已有有效文件会复用；网络失败不自动替换。外部未上报的聊天、本地文件和推理不在平台历史里，也不冒作平台使用费。其它宿主、原生Windows权限和官方插件市场上架各自按实际证据报告。

GitHub Actions沿独立版本和既有OIDC流程发行；普通main只跑CI。包/lock/plugin版本一致，正式新版本用新的creation-v标签，不覆盖或重发0.1.1。详见[发布手册](docs/releasing.md)。
