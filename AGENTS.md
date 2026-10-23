# PromptFrame Creation

此公开仓只维护创作 Skill、安装/setup 与本地 MCP 凭据桥。业务执行、作品、任务、权限、预算和账务由平台 API 管理，不在这里复制第二套实现。

开工先读 README，核真实 Git 根、origin 与 dirty。普通任务分支、受影响测试、提交和合并；不覆盖他人差额。测试使用隔离配置目录，不读取或修改个人 Coding Agent 的配置和登录。

不提交 Token、Cookie、用户作品、私有端点默认值、平台源码、内部提示或协作记录。说明性文档使用中文，代码和协议标识保留英文。新增能力先复用平台公开目录与 schema，不把工具参数手册复制进 Skill。

验证入口：`npm ci --ignore-scripts`、`npm test`。提交前核公开内容和 `git diff --check`。此仓不承载 daemon，不发布 npm 或插件市场版本，除非用户明确要求。

维护客户端、宿主接线与插件安装先读[开发说明](docs/development.md)；打包/发行读[发布手册](docs/releasing.md)。源码、已发行 npm 包和宿主安装副本分别核实；只修文档不自动改版本、重发既有包或触发真实平台任务。
