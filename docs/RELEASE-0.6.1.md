# MieMie Registry 0.6.1

公开 Hub 用户此前共享 Registry 出口 IP 的匿名 GitHub REST 额度。0.6.1 使用服务端 GitHub App Installation Token，集中认证、限流处理和在途查询去重，保留现有机器安装包验证。

- GitHub App 仅需 Contents / Metadata 只读；Token / JWT 仅在服务器内存，私钥通过 Release 目录外的文件加载。production 缺失或无效配置直接拒绝启动，不降级为匿名。
- 只有精确 api.github.com 接收 Authorization；每次 CDN 重定向重新构造请求头并剥离认证。固定来源、超时、流大小限制、digest / contentSha256 / 身份校验和最终 Release 重读保留。
- 使用真实 rate-limit / Retry-After 头，在认证失败或额度受限时冷却；同仓库、初始 Release 与完整 Asset lock 元数据的并发查询有界去重，不落盘缓存社区软件包。
- 公开 health 仅增加 GitHub 上游 healthy/degraded；详细非敏感状态仅由管理员接口读取。Hub 安装 API 成功契约保持兼容。
- DB schema 仍为 5，与 0.6.0 相同，无新增迁移；Extension Package v1 与 Hub 源码不变。

验证：204 项自动测试、构建与秘密扫描通过。真实 Installation Token 能读取安装范围外的公开 cli/cli 仓库、Release 列表、指定 Release 与实际附件；GitHub 返回 5000/hour，CDN 跳转不携带认证。该验证不能代替生产服务账号与生产出口 preflight。

分发文件：`MieMie-Registry-0.6.1-source.tar.gz`、`SHA256SUMS`。这是 Node.js 24+ 服务源码归档，不是酒馆脚本或 Docker 镜像。

升级：保留 0.6.0 回退目录与升级前一致性 DB 备份；现场读取 systemd 运行身份和路径，再检查新 Release、父路径、独立生产私钥以及所有运行必需文件的真实服务账号权限。全部通过后方可原子切换 current；升级后必须实际运行 backup / health service，核验 timer，并完成两个真实 Hub Managed Package 安装。详情见 [部署说明](DEPLOYMENT.md) 和 [GitHub Auth preflight](GITHUB-AUTH-0.6.1.md)。

Founder / Product Author：SheepSheep。官方维护发布命名空间：SheepSheepLab。真实 Contributor、版权与 Git 历史按既有记录保留。
