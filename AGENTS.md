# PromptFrame Creation

此公开仓只维护创作 Skill、安装/setup 与本地 MCP 凭据桥。业务执行、作品、任务、权限、预算和账务由平台 API 管理，不在这里复制第二套实现。

修改前阅读 README，确认 Git 根、origin、当前分支和未提交改动。在同一常驻目录的 main 修改，不创建任务分支或 worktree；同一文件串行修改。完成受影响检查后只提交本次路径并推送，保留其它未提交改动，不自动 stash、覆盖或强推。测试使用隔离配置目录，不读取或修改个人 Coding Agent 的配置和登录。

不提交 Token、Cookie、用户作品、私有端点默认值、平台源码、内部提示或协作记录。说明性文档使用中文，代码和协议标识保留英文。新增能力先复用平台公开目录与 schema，不把工具参数手册复制进 Skill。

验证入口：`npm ci --ignore-scripts`、`npm test`。提交前检查公开内容并运行 `git diff --check`；发行步骤见[发布手册](docs/releasing.md)。

维护客户端、宿主接线与插件安装先读[开发说明](docs/development.md)；打包/发行读[发布手册](docs/releasing.md)。源码、npm 包和宿主安装副本分别核实版本。
