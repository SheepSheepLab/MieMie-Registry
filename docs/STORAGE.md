# 存储、迁移与备份

0.2.1 使用 Node 内置 SQLite（单个 Registry 实例、WAL、外键约束、事务、busy timeout）。`src/store.js` 是 SQL Repository 边界；HTTP 权限和业务流程在 `src/app.js`，更换数据库时可实现同一 Repository 操作，不需更改 Hub API 或重写 OAuth／业务流程。

| 表 | 范围 |
|---|---|
| identities | Discord Snowflake 主键、最新显示名／Username、随机头像引用、更新时间、封禁状态 |
| avatars | 受限 Discord PNG 与随机 key；不公开原始 CDN Snowflake URL |
| sessions | HMAC 后的 Registry 随机 Token、内部身份、原始 Origin、过期时间；不保存原 Token |
| submissions | 独立 UUID、内部 owner、Author、展示字段、来源、受限 GitHub 发现快照、owner_status、moderation、visibility、内部 Guild ID、Discord 链接解析信息、时间 |
| audit | 操作者内部 ID、操作、对象、原因、时间；仅私有数据库 |

Discord OAuth access_token／refresh_token、Email、密码从不入库。OAuth access token、state 和一次性 bridge 仅在服务器内存中，过期或重启失效。不保留 refresh token。Profile 每次登录更新，Submission owner 始终绑定 Snowflake。更换 Display Name／Username 不转移所有权。

数据库使用 `PRAGMA user_version=2`。升级前停止旧版本服务并执行一致性备份；不要让旧版与新版同时访问同一数据库。v1 → v2 在一个事务中复制既有 submissions 的全部字段／ID，添加可见性与 Discord 链接字段，旧记录默认 public；来源唯一约束改为 `(owner_id, source_url)`，避免通过全站重复来源错误探测其他人的受限条目。身份、Session、头像和审计不重建；迁移失败回滚。不要让旧版程序打开新 Schema，恢复旧版时使用升级前快照。首次建立 Schema 同样在事务中完成，发现未来更高版本立即拒绝打开。

运行 `npm run backup` 使用只读连接和 SQLite 官方一致性备份 API，将快照存到被忽略的 `backups/`（可用 `BACKUP_DIRECTORY` 覆盖），不迁移或创建原数据库。不要在正在写入时只复制主 .sqlite 文件而遗漏 WAL。恢复时停止进程，保留故障数据库和 WAL 的私有备份，再将经验证快照放到 DATABASE_PATH，清理仅属于该数据库的旧 WAL/SHM 后启动。生产恢复步骤应由运维复核并先在隔离副本演练。

`data/`、`backups/`、*.sqlite、*.db、WAL/SHM、.env 被 Git 忽略。数据库目录默认 0700；操作系统账户仍须限制访问。备份含内部 Discord ID 和投稿审计记录，不能作为公开 Release 附件。

测试使用内存数据库或系统临时目录隔离数据库，不读取 DATABASE_PATH、生产 .env 或真实用户数据。重启与备份恢复已有自动测试。第一版不支持多服务器并发共享 SQLite 文件、集群 Session 或分布式限流；迁移到 Postgres 等后端时保留公共 UUID／Discord 身份键和审计关系。
