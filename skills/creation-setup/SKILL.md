---
name: creation-setup
description: 安装、连接或升级 PromptFrame Creation，复用平台创作授权并检查 Codex 或 Claude Code 的 Skill 和 MCP 加载。已有连接的普通视频创作使用 video-creation。
---

# 连接 PromptFrame

使用 Studio“连接与授权”提供的完整 API 地址及公开安装入口。保留用户当前环境的 origin 和 `/api`，不替换成 localhost，不从旧聊天猜另一账号或环境。

先确认使用 Codex 还是 Claude Code。Claude 接入使用 `connect --host claude-code`，两种宿主可共用同一 profile 凭据，插件登记分别核实。使用 Studio 对当前环境提供的固定版本；旧版入口不会因平台更新自动改变。Claude 桌面版远程连接 WSL 时，在同一 WSL 安装；没有终端命令时可通过 `--claude-bin <实际可执行文件>` 指定桌面版提供的入口，不固定桌面构建文件名。

<!-- creation-install-command -->
在用户本机终端运行 `npx --yes @promptframe/creation@0.3.3 connect --endpoint <Studio提供的API地址>`。需要隔离另一个环境或账号时显式加 `--profile <用户选择的名称>`；正在运行的桥不会切换。此命令管理用户级版本和 Codex 插件，不向当前项目安装依赖。优先使用 Studio 当前提供的固定推荐版本；每次重新进入此入口比较已安装版本，不后台追踪 latest，也不把旧聊天里的命令当最新版本。已安装更新版不默认降级。
<!-- /creation-install-command -->

<!-- creation-install-command -->
Claude Code 使用 `npx --yes @promptframe/creation@0.3.3 connect --host claude-code --endpoint <Studio提供的API地址>`。桌面版远程连接 WSL 时，在该 WSL 执行；保留相同 profile 和有效凭据。
<!-- /creation-install-command -->

命令会复用并验证有效凭据。首次授权或明确更换已失效凭据时，由用户在 Studio 登录并在终端的不回显输入框提供 Token；不要要求用户把 Token 粘进聊天，也不要把它写进命令参数、URL或日志。网络失败不等于授权失效，不自动轮换或覆盖凭据。

区分安装完成、平台连接成功和当前聊天已加载。首次安装或升级后按结果在同一主机开新聊天或新 session。检查宿主是否同时发现此安装的 setup/video-creation Skill 和 PromptFrame MCP 工具；`npx` 执行成功或 `status` 能读目录不代表当前聊天已有插件。只有真实宿主工具调用带来的身份经平台接受，才确认当前聊天可用；不要向模型参数补 threadId、Token、controlVersion 或 controller。

连接后按用户意图新建或选择作品。歧义名称让用户选目标，不重装、不覆盖原作品。先动态读取平台目录和工具 schema；编辑权申请在 Studio 明确确认，安装本身不会接管作品或启动付费制作。已有任务保留原 task/idempotency，升级或断线后先观察，不重新派发。

如需自行开发组件，沿 README 的独立组件 authoring Skill/CLI；普通创作与平台组件复用不要求安装四个组件包。

官方 npm 来源旧插件返回 `installation.npm_plugin_upgrade_required` 时，升级尚未完成；按包内安装说明处理原插件，不再创建第二个入口。`setup` 仅管理凭据，不能代替 `connect` 的插件安装和版本检查。

出现 `installation.*` 或 `setup.*` 时保留旧版本、凭据及明确错误。不要删除不明配置、终止其它聊天或反复重装追绿。卸载和排障见包内[安装与排障](../../docs/installing.md)。
