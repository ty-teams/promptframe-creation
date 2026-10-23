# 安装、连接与升级

需要 Node.js 20+、支持插件命令的 Codex（本版最低0.160.0），以及可以访问 Studio 的网络。原生 Windows ACL 尚未验证；Linux、WSL、macOS 使用用户目录和私有文件权限，不需要 sudo。

从 Studio 的“连接与授权”复制当前环境的指引。在本机终端执行：

```bash
npx --yes @promptframe/creation@0.2.1 connect --endpoint <Studio提供的API地址>
```

`/api` 会规范化到 `/api/mcp`；也可直接提供 `/api/mcp`。保留 Studio 实际可达的 HTTPS origin，包括私有网络域名，不把远程地址替换成本机 localhost。`0.1.1` 是历史基础包；它不支持此用户级插件引导。新版本是否已发行，以 registry 的实际版本和对应固定标签为准。

首次连接由用户在 Studio 生成创作授权，在终端隐藏输入框输入 Token。自动化可从受限管道使用 `--token-stdin`，不得把 Token 放在参数、聊天、URL、业务仓或日志中。已有有效凭据直接验证复用；失败时保留原凭据，不自动撤销或轮换。仅明确替换时使用 `setup --replace`。

连接入口校验完整包，把自包含运行文件、插件声明及两个 Skill 放入用户级版本目录，通过 `codex plugin marketplace add` 和 `codex plugin add` 注册并核回已启用版本。无需在当前业务仓运行 npm install，也不依赖开发者的 node_modules。目录注册成功与当前聊天已加载分别报告：首次安装或升级后正常重载插件或开新聊天，确认 creation-setup、video-creation 和 MCP 工具均可见。

## 环境与账号

默认凭据沿用 `$XDG_CONFIG_HOME/promptframe-creation/credentials.json`（未配置 XDG 时位于用户 `.config`）。旧的 `PROMPTFRAME_CREATION_CONFIG` 仍可显式引用安全文件。

另一个环境或账号应由用户选择不同名称：

```bash
npx --yes @promptframe/creation@0.2.1 connect --profile work-account --endpoint <另一环境API地址>
```

命名 profile 使用独立凭据和独立插件名；新桥配置固定具体凭据文件。已有文件绑定另一 endpoint 时拒绝覆盖，运行中的桥也不会热切环境。相同 endpoint 的不同账号同样用不同 profile；不要尝试从 Token 或作品名猜账号。`--config <安全文件>` 可指定已存在的私有配置，但不得把不同环境指向同一文件。

## 版本与失败

每个 profile 的安装位于 `$XDG_DATA_HOME/promptframe-creation/<profile>`（默认用户 `.local/share`），版本在 `versions/<version>`。同版本完整内容复用，不再次下载运行依赖；两个入口串行合并。新版本先完整准备和检查，再注册并原子更新 `current.json`。旧版本及其依赖保留，不覆盖、不枚举或终止其它聊天。

更新失败保留旧默认、旧文件及 Token。`registration_unconfirmed_keep_existing` 表示宿主命令结果未确认；先核 Codex 当前插件状态，不根据错误盲重发或删除缓存。普通重试会核原完整版本和实际宿主状态。只在确认本工具 `install.lock/owner.json` 的进程已退出后，才手动移除该精确安装锁并重试；活动或无法确认的进程不清锁。安装锁不决定平台编辑权。

从旧手工 `codex mcp add promptframe` 迁移时，若发现同名定义，引导会停止并给出 `legacy_mcp_entry_requires_review`，不会删除不明配置。确认它是旧的 PromptFrame 手工入口后可用 `codex mcp remove promptframe` 移除定义，再重复 connect。移除定义不取消已接受平台任务、不撤销 Token；在途桥及原结果应沿原 task 观察。

卸载用户级默认插件：`codex plugin remove promptframe-creation@promptframe-creation-user`。命名 profile 的插件和目录名带该 profile 后缀，可先 `codex plugin list` 查看准确 ID。按需用 `codex plugin marketplace remove <准确目录名>` 移除入口。卸载不撤销授权、不取消订单，旧版本也不自动删除；确认无桥进程使用后再清理相应版本目录。撤销 Token 仍由本人在 Studio 操作。

## 开始创作

安装不接管作品、不派发制作。让新聊天按 video-creation 读取当前项目、作品及 schema；已有作品正常申请本人确认，新建空作品沿用户意图。工具调用的宿主 thread 身份由 Codex 自动提供，模型不用填写身份、权限或控制版本。对原 task 的观察与新写入分开：不兼容版本的新写入应升级后再做，原任务不重派、不丢失。

组件复用通过平台目录和 schema；确需开发组件时使用 README 指向的独立 authoring Skill/CLI。MCP 连接不要求安装组件四包。
