# MieMie Registry 0.6.0

- 数据库 schema 4 → 5：主来源统一保存在 `source_type` / `source_url`，GitHub 可选 Discord 发布帖使用 `discord_post_url`；清理冗余数据库链接列。
- Discord 来源统一为原帖 Guild-only；服务端校验成员资格，POST / PATCH 不能将其改为公开。
- 服务端根据来源、产品类型和真实 Package 检测结果推导 distribution。GitHub Tavern 有合法 Package 时支持 Hub 安装，否则仍可作为外部项目收录；Discord Tavern 使用外部发布，Standalone 使用作者发布页，Web 使用网站链接。
- Catalog DTO 继续派生 `githubUrl` / `discordUrl` 兼容已发布 Hub 0.8.0，并提供明确的 `discordPostUrl`。
- 可选 Discord 发布帖不改变 GitHub Official 项目身份；关键来源、仓库、manifest ID 和治理保护保持严格。

Catalog 收录门槛与机器安装门槛分离。GitHub Language 不决定产品类型或安装能力，Package v1 严格校验不变。

分发文件：`MieMie-Registry-0.6.0-source.tar.gz`、`SHA256SUMS`。这是 Node.js 服务源码归档，不是 Docker 镜像、酒馆脚本或可执行二进制；需要 Node.js 24+。

升级要求：先对生产 schema 4 数据执行一致性备份、integrity check 和副本迁移验收；获得生产部署授权后，停服务并按正式流程迁移到 schema 5。不要让旧服务访问新 schema。回滚必须配套升级前一致性快照，不可只切回旧代码。部署流程见 [DEPLOYMENT.md](DEPLOYMENT.md)，模型和事务边界见 [STORAGE.md](STORAGE.md)。

Release Commit Push 不代表服务已部署。当前发布过程仍须经过生产部署与公开 Release Gate。
