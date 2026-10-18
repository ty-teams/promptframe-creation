# PromptFrame Creation

通过自己的客户端推理，使用 PromptFrame 的共用视频工具、作品、素材和持久任务，并与 Studio 接续同一作品。此仓是薄客户端；业务、预算和账务由平台管理。

需要 Node.js 20+。当前安全凭据存储按 Linux、WSL 和 macOS 的文件权限实现；原生 Windows ACL 尚未验证。

```bash
git clone https://github.com/ty-teams/promptframe-creation.git
cd promptframe-creation
npm ci --ignore-scripts
node bin/promptframe-creation.mjs setup --endpoint <platform-api-base>
```

API 地址由你的 Studio 提供，例如占位格式 `https://your-platform.example/api`。没有私有端点默认值。setup 会给出准确 Studio 链接并尝试打开浏览器；浏览器不能打开时手动访问该链接，完成平台登录，在作品操作中选择“连接外部 Agent”。生成或复制创作 Token 后，在 setup 终端隐藏输入。自动化可用 `--token-stdin` 从安全输入管道提供，不能放入命令参数或源码。

已存有效凭据时重复 setup 会直接复用，不调用轮换 API。撤销或过期后，先在 Studio 处理，再显式 `setup --replace` 输入新 Token。平台本人审批和账号/项目权限仍生效；这是独立 Bearer 创作授权，不是 `codex mcp login`。

凭据保存在用户配置目录的 `promptframe-creation/credentials.json`，目录0700、文件0600。可用 `PROMPTFRAME_CREATION_CONFIG` 指定独立安全文件；仓库和 Codex 配置只引用桥，不含 Token。setup 不修改个人 Coding Agent 配置或登录。

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
