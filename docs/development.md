# 客户端与插件开发维护

本仓维护公开创作 Skill、setup、凭据处理、本地 MCP 薄桥和插件声明。平台业务与任务仍由平台 API 执行。开发者先读 AGENTS，确认实际 Git 根、origin、分支和差额，再修改本次任务相关路径。

## 源码路由

| 内容 | 入口 |
| --- | --- |
| 命令和 stdio 桥 | `bin/promptframe-creation.mjs`预检 → `lib/cli.mjs` / `dist/cli.mjs`自包含构建 |
| 用户级安装与profile | `lib/user-installation.mjs` |
| 依赖闭包/许可证 | `scripts/build-runtime.mjs` |
| 环境地址与安全凭据 | `lib/credentials.mjs` |
| 平台 MCP HTTP 连接 | `lib/connection.mjs` |
| 当前源码的宿主 thread 与控制版本接线 | `lib/host-context.mjs` |
| 插件加载与启动 | `.codex-plugin/plugin.json`、`.mcp.json` |
| 公开视频创作规则 | `skills/video-creation/SKILL.md` |
| 插件目录索引 | `.agents/plugins/marketplace.json` |
| 发行内容、版本约束与同包核验 | `scripts/package-release.mjs`、`.github/workflows/ci.yml`、`.github/workflows/publish.yml` |

## 三种版本分别核实

1. 当前工作分支的源码 ref 和未提交差额。
2. 已发行 npm 包对应的固定 tag、registry 版本和 integrity/provenance。
3. 用户宿主实际加载的插件缓存、Skill 和 MCP 连接。

已有 `0.1.1` npm 包固定在 `creation-v0.1.1` / `3da232e267117794fcbcbb1920cbdf9f3f294c14`。后续源码即使尚未 bump package 版本，也不属于这个不可变包。文档描述新宿主行为时注明源码范围；真实发行时按[发布手册](releasing.md)同步包/lock/插件版本并使用新标签。

## 安装与运行路径

当前源码的宿主桥为四个内置只读工具读取真实作品控制版本作为请求元信息；Web或另一线程持写时仍可在原读权限内查询。该版本不会缓存成自己的编辑权。平台还须以当前工具注册表的只读属性及原白名单双重核验，写操作继续要求本线程已获编辑权；模型不能提供控制版本或声明只读来绕过。此源码行为不代表固定npm0.1.1已经包含。

源码经 GitHub Actions 打包发行到 npm；插件目录记录包名/版本或源码位置。安装后，Codex 加载本地副本并按配置启动 Node 桥；桥通过 stdio 接收调用，读取独立安全配置，再通过 HTTPS MCP 连接所选平台。GitHub、npm 与目录索引负责获取版本，不进入正常工具调用链。Token 不进入源码、插件包或命令参数。

0.2.2公开目录固定npm来源；`connect`复用来源和缓存定义可核的已启用官方npm插件；尚未注册时才准备用户级受管版本。受管身份按installation记录和原MCP定义核实，允许安装器Node路径变化，不将未知同名手工入口当作自身安装。`scripts/build-runtime.mjs`显式bundle MCP SDK及必要依赖，拒绝除Node builtins之外的外部import并附第三方许可证。npm_source仍只pack/unpack，不执行npm install；因此`test/package-runtime.test.mjs`从无node_modules解包核可运行。宿主注册/实际Skill及MCP启动另核，普通npm install不代替。

## 相称验证

- 普通源码检查使用本仓 `npm ci --ignore-scripts`、`npm test` 和[发布手册](releasing.md)的 pack/smoke；测试使用临时配置目录。
- 修改宿主接线时核实际宿主元数据、缺失身份和多聊天隔离，不要求模型记忆身份字段；源码控制与真实宿主旅程分别记录。
- 修改插件内容或安装流程时，从无既有依赖/凭据污染的目标环境核 manifest、Skill、桥启动和平台连接；保持现有有效凭据，升级不默认轮换 Token。
- 普通打包/文档检查不调用真实平台 setup、生成媒体或模型。真实接入、任务和费用按当前实际授权执行；Skill 或 README 本身不授予权限。
- 只改文档不自动发包或更新服务。交付说明记录源码、技术检查、registry 发行、宿主注册和真实创作的实际结果，未做项保持未验证。

## 公开范围

使用说明保持公开且可移植。平台私有配置、真实端点默认值、用户样本、Token、内部协作材料和业务权限实现不进入本仓。组件创作需要的工具按 README 指向独立 authoring 仓；不在本仓维护第二套组件 CLI 参数手册或四包发行流程。
