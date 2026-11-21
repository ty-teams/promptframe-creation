# 本机账号目录格式

当前主分支新增的目录能力与已发行版本分别核实。目录记录可发现的本机授权引用，不保存 Token 或 Cookie，也不授予平台权限。创作 MCP 与组件 CLI 继续使用各自的安全配置和实际服务校验。

`promptframe-creation accounts list` 读取已登记摘要；`accounts refresh --profile <名称>` 沿原 profile 作一次正常认证观察并更新其引用，不签发或轮换 Token。正常 setup/connect 和桥启动也登记已验证身份。旧的自定义配置只有显式使用后才能发现，不递归扫描用户磁盘。

新桥提供 `promptframe_local_accounts` 与 `promptframe_local_select_account`。前者列出本机摘要，后者使用列表中的 `identityKey`，同账号有多份授权时可附 `referenceId`。选择前验证原配置和认证连接的身份，成功后仅更新当前宿主会话。选择不申请作品编辑权，不重新提交已受理请求，不终止旧账号正在返回的请求。

多份授权的 `referenceId` 选择保留在当前桥中；宿主会话的持久选择只记录账号。重启桥后，若该账号仍有多份候选且没有匹配的原 profile，需要再次明确引用，不能猜哪份权限较大。

## 身份与授权引用

身份使用平台经认证连接返回的 `promptframe-account-identity/v1`：

```json
{
  "contractVersion": "promptframe-account-identity/v1",
  "platformDigest": "sha256:<64个小写十六进制字符>",
  "accountDigest": "sha256:<64个小写十六进制字符>"
}
```

平台和账号摘要沿实际认证合同；显示名、邮箱、项目名和业务正文不能建立身份。Creation 从 MCP initialize 的 `experimental.promptframe.accountIdentity` 取得摘要。旧平台没有该扩展时，原 profile 流程保持兼容；显式按目录选择账号需要可核身份。

目录默认位于 `XDG_CONFIG_HOME/promptframe/accounts/v1`；未指定 XDG 时使用用户配置目录。测试可用 `PROMPTFRAME_ACCOUNT_DIRECTORY` 指定隔离根，不能以此覆盖个人 Token。目录须支持当前用户属主、0700 目录、0600 普通文件、无符号链接检查；无法可靠检查时明确拒绝目录操作，已有 profile 不依赖目录存在。

每份引用使用独立文件，避免两个客户端覆盖同一个总 JSON：

```text
identities/<platformHex>/<accountHex>/<client>/<referenceHex>.json
```

`client` 为 `creation` 或 `component-cli`。`referenceId` 是 `sha256(JSON.stringify([client, path.resolve(configFile)]))`。同一身份合为一行，多份 profile 是这一行下的不同授权引用；重复登记同一引用只更新同一文件。

引用包含 `contractVersion: promptframe-local-account-directory/v1`、`identity`、`client`、`referenceId`、本机绝对路径 `configFile`、`endpoint`、`credentialDigest`、`observedAt`，以及可选的 `profile`、`expiresAt`、`scopes`。`credentialDigest` 是原 Token 字符串的 SHA-256，用于识别引用变化，不是认证证明。绝对路径和摘要只留在私有目录，不出现在账号列表中。

列表只返回身份键、账号摘要、授权种类、引用 ID、profile、观察时间和存储或到期状态。`stored` 表示本机有一次授权记录，不表示平台当前仍批准它；操作前仍读取原安全配置并核对实际账号、scope、撤销和期限。没有组件 CLI 授权，或只有过期的 CLI 引用时，明确报告缺失，不能借另一个账号的授权。

单个元数据文件限制为 16 KiB，目录读取每级最多 256 项，超过时明确报告不完整的读取条件，不把截断内容当作全部账号。按准确身份读取引用不依赖全目录扫描。这些限制仅约束本机索引元数据，不限制作品或上传文件大小。

## 当前 Agent 的选择

选择文件位于 `selections/<kind>-<agentHex>.json`。`kind` 为 `codex` 或 `claude-code`，`agentDigest` 为 `sha256(JSON.stringify([kind, sessionId.toLowerCase()]))`。调用方必须沿原宿主 transport/hook 取得当前会话身份，不能采用模型业务参数中的任意会话号。

文件包含 `contractVersion: promptframe-local-agent-account/v1`、`agentKind`、`agentDigest`、随机 UUID `generation`、`identity` 和 `selectedAt`。不存在全局 selected/default 账号文件。切换只写当前 Agent 对应的一格，不覆盖其它 profile、修改其它 Agent 的桥或改变已受理任务的归属。缺少合法宿主身份时不能写持久选择。

实际连接须与所选身份一致；本机索引不能让旧授权获得新权限。在途请求仍保留其发起时的账号和回执，晚回结果不能填进另一个账号的控制或作品缓存。

Codex 使用请求的原宿主上下文；Claude 使用已验证的当前 hook 凭证，选择连接与转发业务只消费一次同一凭证。切换后的调用需要可核宿主身份，缺失时明确拒绝，不猜另一个会话。新账号的上传检查点按账号与宿主分开，原 profile 的已有检查点保持原位，旧请求不改归属。

目录不存在时仍可使用原 profile。已选账号的目录损坏或读取失败返回 `accounts.storage_unavailable` 或相应安全错误，不静默换回另一个账号。缺少创作引用、授权到期、引用文件变化与认证身份不符分别报告，不重新登录或自动扩大权限。原生 Windows 的文件 ACL 与实际桌面会话加载仍需单独验证。
