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

Codex CLI 可显式添加 stdio 桥（把 `<checkout>` 换成此仓的绝对路径）：

```bash
codex mcp add promptframe -- node <checkout>/bin/promptframe-creation.mjs bridge
codex mcp get promptframe
node bin/promptframe-creation.mjs status
```

支持本地插件的 Codex 界面也可加载本仓 `.codex-plugin/plugin.json`。它声明公开 Skill 和 stdio 桥；`${PLUGIN_ROOT}` 的用法沿 [OpenAI 的本地 MCP 说明](https://developers.openai.com/plugins/deploy/desktop-only)。安装后按该客户端的 Skill 发现方式使用 `video-creation`。这里不代表已发布到插件目录或 npm。

开始前读取平台当前项目、作品、编辑权及业务工具 schema。已有作品需本人在 Studio 确认接管；首次制作也由平台本人确认。已接受的异步工具返回持久 task，客户端停止等待不取消订单。网络结果未知时查原 task 或用相同幂等键重试。本人可随时接回网页，原费用与期限保持。

外部未上报的聊天、思考和本地文件不在平台历史里。Skill 引导先复用、再用自己的能力制作并上传 ready 素材；外部自费推理与素材不冒作平台使用费。

```bash
npm test
```
