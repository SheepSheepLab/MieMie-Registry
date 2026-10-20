# MieMie Registry 0.7.0 — 发行说明草稿

Owner 已批准产品版本 **0.7.0**，预期 Tag `v0.7.0`。当前是未发行、未部署候选；不替换既有 0.6.1 Release／Assets。REGISTRY_VERSION仍从package.json读取，不新增硬编码版本。

- Catalog与受限GitHub Relay共享Manifest／Package验证；支持Extension API1／API2声明，hubApi必须为有效正安全整数范围并包含声明版本。服务端接受声明不等于Hub可执行该Runtime；新版官方Extension只采用Hub Runtime API2。
- Registry HTTP API仍v1，DB Schema仍5，Manifest／Managed Package／Machine Metadata／Build Identity Schema仍1。API2本身不增加DB迁移，不降低身份、Release／Asset锁、digest、完整附件及content SHA-256、大小和空公开data校验。
- OAuth／精确Origin允许来源与API2是独立合同；生产API2和生产Origin／OAuth分别Pending，不扩大allowlist或关闭认证/CORS。

本版实际测试、独立重建及源归档hash由最终候选回执给出，不沿用0.6.1的旧产物hash或204项历史记录。部署仍须Owner单独授权，严格执行 [DEPLOYMENT](DEPLOYMENT.md#api2-候选未来部署前置条件未授权执行)：读取真实systemd User／Group／WorkingDirectory／ExecStart，核对新Release及父路径owner/group/mode，用实际账号读取全部运行文件。失败禁止切current、迁移DB或启动，禁止chmod777。

backup／health timer调用current对应版本正式工具，不硬编码Registry或DB Schema版本。获准升级后实际执行backup／health service并确认timer active、最近成功及下一触发时间。生产数据备份、副本验证与恢复方案须依据当时真实生产状态，不能只切旧代码冒充数据库回滚。

## 本版自动验证

本轮 0.7.0 源码重新执行 `npm test`：314 PASS／0 FAIL／0 SKIP；正式 `npm run build` 两次通过。服务版本仍由 package.json 读取，隔离 `/health` 实际返回 0.7.0；HTTP API v1、DB Schema5、机器 Schema1 的源码与测试不变。最终签名 HEAD 的 Linux CI、独立空目录重建及源码归档 SHA-256 随 Owner 本轮审核包交付，不能沿用 0.6.1 产物 hash。生产部署、真实服务账号权限预检、backup／health service 与 timer 验收需另行授权执行。
