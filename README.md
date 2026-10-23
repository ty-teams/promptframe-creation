# PromptFrame Creation

通过自己的客户端推理，使用 PromptFrame 的共用视频工具、作品、素材和持久任务，并与 Studio 接续同一作品。此仓是薄客户端；业务、预算和账务由平台管理。

需要 Node.js 20+。当前安全凭据存储按 Linux、WSL 和 macOS 的文件权限实现；原生 Windows ACL 尚未验证。

## npm 基础版

`@promptframe/creation@0.1.1` 提供 `setup`、`status`、`bridge` 及包内的 `video-creation` Skill。首次发行状态以官方 npm registry 为准。可使用以下命令配置并连接 MCP：

```bash
npx --yes @promptframe/creation@0.1.1 setup --endpoint <platform-api-base>
codex mcp add promptframe -- npx --yes @promptframe/creation@0.1.1 bridge
```

这是基础 MCP 接法；此命令不自动加载创作 Skill，配套插件安装见下文。当前客户端身份按一份安全配置中的 clientId 区分，使用同一配置的聊天共享该身份；需要分别控制作品时使用独立配置。自动按 Codex 聊天隔离、用户级安装引导、自动升级与 Studio 活跃入口属于后续版本能力。本版的范围见[0.1.1 说明](docs/releases/0.1.1.md)。

```bash
git clone https://github.com/ty-teams/promptframe-creation.git
cd promptframe-creation
npm ci --ignore-scripts
node bin/promptframe-creation.mjs setup --endpoint <platform-api-base>
```

API 地址由你的 Studio 提供，例如占位格式 `https://your-platform.example/api`。没有私有端点默认值。setup 会给出准确 Studio 链接并尝试打开浏览器；浏览器不能打开时手动访问该链接，完成平台登录，在作品操作中选择“连接外部 Agent”。生成或复制创作 Token 后，在 setup 终端隐藏输入。自动化可用 `--token-stdin` 从安全输入管道提供，不能放入命令参数或源码。

已存有效凭据时重复 setup 会直接复用，不调用轮换 API。撤销或过期后，先在 Studio 处理，再显式 `setup --replace` 输入新 Token。平台本人审批和账号/项目权限仍生效；这是独立 Bearer 创作授权，不是 `codex mcp login`。

凭据保存在用户配置目录的 `promptframe-creation/credentials.json`，目录0700、文件0600。可用 `PROMPTFRAME_CREATION_CONFIG` 指定独立安全文件；仓库和 Codex 配置只引用桥，不含 Token。setup 不修改个人 Coding Agent 配置或登录。

## 平台地址与环境

首次连接时，由用户提供所用 Studio 的 API 地址，传给 `setup --endpoint`。GitHub 仓库地址不是平台地址；客户端不会根据当前工作目录或 Token 猜测域名，也没有内置生产地址。传入的 `/api` 会规范化为 `/api/mcp`，也可直接提供 `/api/mcp`。

本地同机接入可使用 `http://localhost:3500/api`；正式服务使用该部署提供的 HTTPS API 地址。这里的 localhost 指桥进程所在的运行环境，容器或远程客户端需使用其实际可达地址。地址与该环境生成的 Token 一起保存在同一份安全配置文件中。

本地与生产使用不同的 `PROMPTFRAME_CREATION_CONFIG` 文件。已有文件绑定另一地址时，setup 会要求独立配置，不会覆盖切端。启动 Codex/桥时固定使用对应配置路径；运行中的桥不会因修改环境变量或配置文件而热切换，切换后需重启对应连接。当前没有内置多环境选择命令。

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

## 连接 Codex

完成上面的 `npm ci --ignore-scripts` 和 setup 后，选择以下一种接法。同一客户端不要同时启用两份桥，以免显示重复工具。

Codex CLI 可显式添加 stdio 桥（把 `<checkout>` 换成此仓的绝对路径）：

```bash
codex mcp add promptframe -- node <checkout>/bin/promptframe-creation.mjs bridge
codex mcp get promptframe
node bin/promptframe-creation.mjs status
```

使用独立配置文件或自定义 XDG 配置目录时，在该条 `mcp_servers.promptframe` 配置中加 `env_vars = ["PROMPTFRAME_CREATION_CONFIG", "XDG_CONFIG_HOME"]`，让 Codex 只向桥转发这两个路径变量；参见 [Codex 的 stdio 环境配置](https://learn.chatgpt.com/docs/extend/mcp#stdio-servers)。默认安全目录不需要这一步。这里传递的是路径，Token 仍只在安全文件中。

也可通过本仓的本地插件目录安装，配套加载 `video-creation` Skill 和 stdio 桥。在支持以下命令的 Codex CLI 中运行：

```bash
codex plugin marketplace add <checkout>
codex plugin add promptframe-creation@promptframe-creation-local
codex plugin list
```

支持本地插件的 ChatGPT 桌面端可按 [OpenAI 的本地目录安装说明](https://developers.openai.com/plugins/build/plugins#install-a-local-plugin-manually)，选择 `PromptFrame Creation (local)` 后安装插件。目录入口是本仓 `.agents/plugins/marketplace.json`，相对路径从 checkout 根解析；插件由 `.codex-plugin/plugin.json` 声明。不同客户端版本的安装入口可能不同，以该版本的命令帮助和官方说明为准。

先安装依赖，再安装插件：本地目录会复制插件到客户端缓存，桥需要一起带入 `npm ci` 生成的 `node_modules`。只复制 manifest 或尚未安装依赖的源码目录，会缺少运行依赖。更新 checkout 后再次运行 `npm ci --ignore-scripts`，按客户端的卸载、重装流程刷新缓存，并重启客户端；仅修改源码不代表缓存已更新。

桥使用 `cwd: "."` 从已安装的插件根目录启动，脚本参数是相对路径；该路径解析由 [Codex 的插件配置实现](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/codex-mcp/src/plugin_config.rs)提供。凭据继续从用户安全配置目录读取，既不打进插件，也不写入 Codex 配置。插件会转发 `PROMPTFRAME_CREATION_CONFIG` 和 `XDG_CONFIG_HOME` 两个路径变量，需让启动 Codex 的进程继承 setup 时的值。安装后确认桥已连接、能读取平台工具，再使用 `video-creation`；插件安装成功本身不代表平台授权或创作成功。这里不代表已发布到公共插件目录或 npm。

卸载插件可用该客户端的卸载入口，支持时也可运行 `codex plugin remove promptframe-creation@promptframe-creation-local`；显式添加的桥则使用 `codex mcp remove promptframe`。这只移除客户端接线，不撤销平台 Token 或取消已接受任务。需要撤销创作授权时，仍由本人在 Studio 处理。

开始前读取平台当前项目、作品、编辑权及业务工具 schema。已有作品需本人在 Studio 确认接管；首次制作也由平台本人确认。已接受的异步工具返回持久 task，客户端停止等待不取消订单。网络结果未知时查原 task 或用相同幂等键重试。本人可随时接回网页，原费用与期限保持。

外部未上报的聊天、思考和本地文件不在平台历史里。Skill 引导先复用、再用自己的能力制作并上传 ready 素材；外部自费推理与素材不冒作平台使用费。

```bash
npm test
```

## 维护与发行

GitHub Actions 检查 Node 20/24、包内容和隔离安装。npm 发布使用独立版本及 GitHub OIDC，配置和操作见[发布手册](docs/releasing.md)。手工运行发布工作流只做检查；正式发行需要匹配的版本标签。首次包初始化与 npm 信任绑定完成后，后续版本由工作流自动发布。
