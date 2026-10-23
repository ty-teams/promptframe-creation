---
name: creation-setup
description: 安装、连接或升级 PromptFrame Creation 的 Codex 插件，复用平台创作授权并检查 Skill 和 MCP 是否已加载。已有连接的普通视频创作使用 video-creation。
---

# 连接 PromptFrame

使用 Studio“连接与授权”提供的完整 API 地址及公开安装入口。保留用户当前环境的 origin 和 `/api`，不替换成 localhost，不从旧聊天猜另一账号或环境。

在用户本机终端运行 `npx --yes @promptframe/creation connect --endpoint <Studio提供的API地址>`。需要隔离另一个环境或账号时显式加 `--profile <用户选择的名称>`；正在运行的桥不会切换。此命令管理用户级版本和 Codex 插件，不向当前项目安装依赖。

命令会复用并验证有效凭据。首次授权或明确更换已失效凭据时，由用户在 Studio 登录并在终端的不回显输入框提供 Token；不要要求用户把 Token 粘进聊天，也不要把它写进命令参数、URL或日志。网络失败不等于授权失效，不自动轮换或覆盖凭据。

区分安装完成、平台连接成功和当前聊天已加载。首次安装或升级后按命令结果正常重载插件或开新聊天。检查宿主是否同时发现此安装的 setup/video-creation Skill 和 PromptFrame MCP 工具；`npx` 执行成功或 `status` 能读目录不代表当前聊天已有插件。只有真实宿主工具调用带来的身份经平台接受，才确认当前聊天可用；不要向模型参数补 threadId、Token、controlVersion 或 controller。

连接后按用户意图新建或选择作品。歧义名称让用户选目标，不重装、不覆盖原作品。先动态读取平台目录和工具 schema；编辑权申请在 Studio 明确确认，安装本身不会接管作品或启动付费制作。已有任务保留原 task/idempotency，升级或断线后先观察，不重新派发。

如需自行开发组件，沿 README 的独立组件 authoring Skill/CLI；普通创作与平台组件复用不要求安装四个组件包。

出现 `installation.*` 或 `setup.*` 时保留旧版本、凭据及明确错误。不要删除不明配置、终止其它聊天或反复重装追绿。卸载和排障见包内[安装与排障](../../docs/installing.md)。
