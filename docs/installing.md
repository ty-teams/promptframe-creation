# 安装、连接与升级

需要 Node.js 20+，支持插件命令的 Codex0.160.0+ 或 Claude Code2.0.12+，以及可以访问 Studio 的网络。原生 Windows ACL 尚未验证；Linux、WSL、macOS 使用用户目录和私有文件权限，不需要 sudo。

从 Studio 的“连接与授权”复制当前环境的指引。在本机终端执行：

<!-- creation-install-command -->
```bash
npx --yes @promptframe/creation@0.3.0 connect --endpoint <Studio提供的API地址>
```
<!-- /creation-install-command -->

`/api` 会规范化到 `/api/mcp`；也可直接提供 `/api/mcp`。保留 Studio 实际可达的 HTTPS origin，包括私有网络域名，不把远程地址替换成本机 localhost。`0.1.1` 是历史基础包；它不支持此用户级插件引导。新版本是否已发行，以 registry 的实际版本和对应固定标签为准。

首次连接由用户在 Studio 生成创作授权，在终端隐藏输入框输入 Token。自动化可从受限管道使用 `--token-stdin`，不得把 Token 放在参数、聊天、URL、业务仓或日志中。已有有效凭据直接验证复用；失败时保留原凭据，不自动撤销或轮换。仅明确替换时使用 `setup --replace`。

连接入口校验完整包，把自包含运行文件、插件声明及两个 Skill 放入用户级版本目录，通过 `codex plugin marketplace add` 和 `codex plugin add` 注册并核回已启用版本。无需在当前业务仓运行 npm install，也不依赖开发者的 node_modules。目录注册成功与当前聊天已加载分别报告。

安装后在同一主机开一个 **Local 新聊天**；CLI 使用新 session。选择独立的非 Git 创作目录即可，不必复制产品仓或创建 Worktree，也不用重装或更换 Token。在新聊天确认 `creation-setup`、`video-creation` 两个 Skill 和 PromptFrame MCP 工具一起可用，再开始创作。现有聊天不必关闭；安装器不重启宿主或其它聊天，也不承诺能从外部 npx 强刷原 GUI 会话。[官方插件说明](https://learn.chatgpt.com/docs/plugins)要求安装后使用新聊天/新 session。

安装输出分别报告插件已安装、已启用、平台凭据连接已核验；`hostMcpConnected` 与 `sessionLoaded` 在安装器中仍为 `not_verified`。当前聊天是否已加载，要由该聊天实际发现 Skill 和调用 MCP 只读工具验证。若宿主将来提供明确受支持的同会话刷新入口，也须同时核回这两类能力后才能报告加载成功。

## Claude Code 接入

在 Claude Code 所在主机使用同一固定包和独立宿主参数。桌面版连接 WSL 时，在该 WSL 运行：

<!-- creation-install-command -->
```bash
npx --yes @promptframe/creation@0.3.0 connect --host claude-code --endpoint <Studio提供的API地址>
```
<!-- /creation-install-command -->

CLI 优先使用 PATH 中的 Claude；桌面版远程连接 WSL 时，也识别同一用户桌面端管理的实际远程构建。可用 `--claude-bin <绝对可执行文件>` 明确指定入口。不会启动 Claude 模型会话或固定桌面构建文件名。

两个宿主共用所选 profile 的安全凭据，插件登记和版本目录独立。Claude 适配通过官方 user-scope 本地 marketplace/install 命令注册，再读取完整插件身份、实际版本目录、MCP 定义和文件摘要；当前聊天是否加载仍需在同一主机的新 Claude Code session 检查两个 Skill 与 MCP。安装期间不会替换活动桥或清理旧版本。登记回程未知时只核原身份，不能重复 install 或改用另一登记方式。已有同名手工 MCP、其它来源或不明目录需要先核实，不自动覆盖。

本机隔离检查覆盖 CLI 插件登记与版本复用；桌面版真实加载、恢复会话和编辑权仍单独验证。原生 Windows ACL 尚未验证。

启动帮助明确不提供插件命令时，安装器使用官方 user-scope MCP 登记并准备两份用户 Skill。返回 `installationMode: mcp-and-skills`、`pluginInstalled: false` 与实际 Skill 名称；不同 profile 分开命名，原凭据保持。MCP 写后从本地配置核回，不通过 `mcp list/get` 启动健康检查。已有陌生 MCP/Skill 或未确认的插件安装不会转到备用路径；备用 MCP 的回程未知也只核原身份，不重复 add。以后宿主增加插件命令时保留现有备用登记，避免同一 profile 两份连接。

## 环境与账号

默认凭据沿用 `$XDG_CONFIG_HOME/promptframe-creation/credentials.json`（未配置 XDG 时位于用户 `.config`）。旧的 `PROMPTFRAME_CREATION_CONFIG` 仍可显式引用安全文件。

另一个环境或账号应由用户选择不同名称：

<!-- creation-install-command -->
```bash
npx --yes @promptframe/creation@0.3.0 connect --profile work-account --endpoint <另一环境API地址>
```
<!-- /creation-install-command -->

命名 profile 使用独立凭据和独立插件名；新桥配置固定具体凭据文件。已有文件绑定另一 endpoint 时拒绝覆盖，运行中的桥也不会热切环境。相同 endpoint 的不同账号同样用不同 profile；不要尝试从 Token 或作品名猜账号。`--config <安全文件>` 可指定已存在的私有配置，但不得把不同环境指向同一文件。

## 版本与失败

新会话启动时，根据平台给出的最低和推荐版本选择兼容的固定 npm 包。包从官方 registry 获取并校验完整性，已校验缓存可以复用；Token、profile 和会话身份保持。可在桥启动配置中加 `--bridge-version X.Y.Z` 锁定版本，锁定低于最低要求时会明确拒绝。获取失败时仅兼容的当前程序可继续；显式锁定失败不会悄悄使用另一个版本。活动聊天的桥不被替换，源码中的新启动能力也不会自动出现在既有旧版插件中。

推荐版本由 Studio 当前连接指引提供，入口每次对照命令中的固定版本检查安装。同版本复用；受管旧版准备新版并切换后续入口；已安装更新版返回 `newer_retained`，不降级。没有后台自动追踪 latest；再次连接时从 Studio 复制当前指令，不沿用旧聊天中的版本。

每个 profile 的安装位于 `$XDG_DATA_HOME/promptframe-creation/<profile>`（默认用户 `.local/share`），版本在 `versions/<version>`。同版本完整内容复用，不再次下载运行依赖；两个入口串行合并。新版本先完整准备和检查，再注册并原子更新 `current.json`。旧版本及其依赖保留，不覆盖、不枚举或终止其它聊天。

更新失败保留旧默认、旧文件及 Token。`registration_unconfirmed_keep_existing` 表示宿主写命令结果未确认；先核 Codex 当前插件状态，不根据错误盲重发或删除缓存。安装器在写前保存该 profile 的 `registration-pending.json`；再次 connect 只观察同一插件和版本。确认已登记则正常完成，否则保留待核状态，不自动第二次 add 或用旧版 add 作补偿。只有原宿主登记责任核清后才安排后续处理。只在确认本工具 `install.lock/owner.json` 的进程已退出后，才手动移除该精确安装锁并重试；活动或无法确认的进程不清锁。安装锁不决定平台编辑权。

安装核验读取宿主结构化本地 marketplace 索引和有界目录文件，再仅查询全部相关 marketplace；无关远端目录不进入安装必需路径。目录不可读、JSON/输出超限、查询超时不代表“未安装”。错误只报告阶段、命令种类、耗时、期限、退出码/信号及下一动作，不透传子进程 stdout/stderr、环境或凭据。安装器不使用全量远端插件列表作为安装前提。

从旧手工 `codex mcp add promptframe` 迁移时，若发现同名定义，引导会停止并给出 `legacy_mcp_entry_requires_review`，不会删除不明配置。确认它是旧的 PromptFrame 手工入口后可用 `codex mcp remove promptframe` 移除定义，再重复 connect。移除定义不取消已接受平台任务、不撤销 Token；在途桥及原结果应沿原 task 观察。

卸载用户级默认插件：`codex plugin remove promptframe-creation@promptframe-creation-user`。命名 profile 的插件和目录名带该 profile 后缀，可先 `codex plugin list` 查看准确 ID。按需用 `codex plugin marketplace remove <准确目录名>` 移除入口。卸载不撤销授权、不取消订单，旧版本也不自动删除；确认无桥进程使用后再清理相应版本目录。撤销 Token 仍由本人在 Studio 操作。

## 开始创作

安装不接管作品、不派发制作。让新聊天按 video-creation 读取当前项目、作品及 schema；已有作品正常申请本人确认，新建空作品沿用户意图。工具调用的宿主 thread 身份由 Codex 自动提供，模型不用填写身份、权限或控制版本。对原 task 的观察与新写入分开：不兼容版本的新写入应升级后再做，原任务不重派、不丢失。

组件复用通过平台目录和 schema；确需开发组件时使用 README 指向的独立 authoring Skill/CLI。MCP 连接不要求安装组件四包。

## 已有官方插件与 Node 路径变更

已通过官方 npm 来源安装并启用的插件，`connect` 核来源、缓存、实际 MCP 定义及可执行运行环境。同版本复用；比指令更新的版本保留并返回 `newer_retained`；旧版明确返回 `installation.npm_plugin_upgrade_required`，附实际版本和请求版本，退出码为1，不报告升级成功，也不创建第二个入口。

Codex CLI 0.160.0 的 `plugin add` 升级 npm 插件会移除旧缓存，当前没有可保留旧缓存的升级选项。因此不能在不知道其他聊天是否仍用旧桥时自动执行该命令。处理步骤：

1. 等使用该插件的活动聊天和桥结束。平台已受理的媒体任务保持原 task，升级后继续查询，不重派。
2. 用 `codex plugin marketplace list --json` 和 `codex plugin list --marketplace <原准确目录名> --json` 确认原插件 ID、目录来源和当前版本。
3. Git 来源目录使用 `codex plugin marketplace upgrade <原目录名> --json` 更新目录；本地目录由其维护者更新到包含目标 npm 版本的目录。不要新注册一个同名插件来绕过升级。
4. 确认目录中的版本是目标版本后，执行 `codex plugin add <原插件ID> --json`。再次 `codex plugin list --marketplace <原准确目录名> --json` 核目标版本已启用，再运行 Studio 的 `connect` 指令并开 Local 新聊天。目录未提供目标版或升级失败时保持待升级，不循环卸载重装。

受管入口按原安装记录核身份，不以当前 Node 路径认领。每次复用会实际运行已记录的 Node 和该版本 `--version`（各最多10秒，无平台调用），缺失、低于20或无法启动时返回 `installation.recorded_node_unavailable`。可恢复原 Node.js 20+ 路径，或运行 Studio 提供的较新版本 connect：新的受管版本使用当前 Node，保留旧代码及原凭据。相同版本不会偷偷重写旧启动配置。官方 npm 插件的 `node` 按当前宿主环境的 PATH 检查；Desktop 重载后的真实 MCP 启动仍须单独确认。

## 固定 Git 来源

`installation.pinned_git_plugin_upgrade_required` 表示现有插件或其 marketplace 固定到提交 SHA 或版本标签。`codex plugin marketplace upgrade <原目录名> --json` 只刷新已经配置的 ref，不会选择另一个版本。先完成使用旧桥的聊天，通过原宿主支持的来源配置选择目标 ref，再用 `codex plugin marketplace list --json` 与 `codex plugin list --marketplace <原目录名> --json` 核对同一插件。当前宿主没有来源修改入口时，保留现有安装并处理该来源配置；不要连续 add、删除活动缓存或更换 Token。参见[Codex 插件命令](https://learn.chatgpt.com/docs/developer-commands#codex-plugin-marketplace)。
