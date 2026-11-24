# dsh-mysql-data-recovery

**mysql数据恢复** — 一个用于 DeepSeek Harness（DSH）的 MySQL binlog 回滚 SQL 生成插件。

它注册一个 DSH 工作区页面，按时间窗口或“执行过的 SQL”读取 MySQL binlog，生成回滚 SQL 文件，并显示扫描进度和 SQL 预览。**插件只生成 SQL，不会自动执行回滚 SQL，也不会自动创建/删除用户。**

- 不依赖本机 MySQL DBA 桌面程序；
- Host helper 只使用 Python `pymysql` 和 `mysql-replication`；
- 密码不进入模型工具参数，也不写入报告或 SQL 文件（临时用户 SQL 文件除外，它必须包含随机密码）。

![mysql数据恢复界面预览](docs/preview.svg)

## 功能

- **表级恢复**：本地当前时间的最近 5 分钟 / 15 分钟 / 1 小时快捷选择，或手动时间范围；可选择 `INSERT` / `UPDATE` / `DELETE`，默认全选。
- **SQL 级恢复**：填写执行过的 SQL + 时间范围。
- **扫描进度**：`已扫描事件：N`，以及扫描开始/结束时间。
- **只返回回滚 SQL 文件路径、匹配条数和 SQL 预览**；不查询表信息、表大小或行数。
- **临时用户 SQL**：独立按钮生成 `CREATE USER ... PASSWORD EXPIRE INTERVAL 1 DAY`、`GRANT` 和 `DROP USER`，不自动执行。
- **单表授权**：临时用户可授权 `db.table`（单表）或 `db.*`（整库）。
- **打开 SQL 所在目录**：优先使用 DSH 原生桌面打开能力，回退到 `explorer.exe` / `open` / `xdg-open`。
- **表单保留**：切换页面后保留非密码字段；密码不保存，切回后重新输入。

## 安装

### 通过 DSH 插件页安装（npm 发布后）

在 DSH 的 **Plugins** 页面选择 **Add plugin**，输入：

```text
dsh-mysql-data-recovery
```

或使用 CLI：

```bash
dsh plugin --profile web add dsh-mysql-data-recovery
```

### 从 GitHub 安装

```bash
dsh plugin --profile web add github:mumu1001ai-jpg/dsh-mysql-data-recovery
```

### 本地开发安装

在 DSH Plugins 页面选择 **Add plugin**，选择本仓库根目录即可安装本地开发版本。

## 环境要求

- DSH profile 含 Web client；
- Node.js 20+；
- DSH Host 所在机器有 Python 3：

```bash
python -m pip install pymysql mysql-replication
```

如果 `python` 不在 PATH，可指定解释器：

```powershell
$env:DSH_MYSQLRECOVER_PYTHON = "C:\Python313\python.exe"
```

## MySQL 权限

恢复账号至少需要：

```sql
GRANT SELECT ON `your_db`.* TO 'recovery'@'%';
GRANT REPLICATION CLIENT ON *.* TO 'recovery'@'%';
GRANT REPLICATION SLAVE  ON *.* TO 'recovery'@'%';
```

- `SELECT`：读取列名，生成回滚 SQL；
- `REPLICATION CLIENT`：`SHOW BINARY LOGS`；
- `REPLICATION SLAVE`：读取 binlog 事件流；
- MySQL 8.4 如提示 `REPLICATION SLAVE` 不可用，改用 `REPLICATION REPLICA`。

要求 `binlog_format=ROW`、`binlog_row_image=FULL`。DDL 不在恢复范围内。

## 使用流程

1. 打开左侧 **mysql数据恢复**；
2. 填写主机、端口、库、表、数据库用户和密码；
3. 选择时间窗口，或点击最近 5 / 15 / 60 分钟快捷按钮；
4. 点击 **生成恢复 SQL**；
5. 查看扫描进度、开始/结束时间和 SQL 预览；
6. 点击 **打开 SQL 所在目录**，审阅完整 SQL；
7. 在测试库/从库验证后，在事务中分批执行。

临时恢复账号是独立步骤：填写用户名和授权恢复表，点击 **生成临时用户 SQL**，执行文件中的 `CREATE USER` / `GRANT`，恢复完成后执行 `DROP USER`。

## 安全说明

- 密码只在本页输入，通过 Host 用户命令传递，不作为模型工具参数，也不会写进报告。
- 切换到其他页面后密码会清除；非密码字段会保留。
- Host 命令仍会在本机会话日志中留下命令生命周期记录，需及时修改密码。
- 临时用户 SQL 文件包含随机密码，请限制文件权限，并在恢复验证成功后及时删除临时用户。
- 插件不会自动执行回滚 SQL、不会自动创建/删除用户。

## 文档

- [详细使用说明](docs/USAGE.md)
- [更新日志](CHANGELOG.md)
- [许可证](LICENSE)

## 开发

```bash
node --check index.js
node --check client.js
python -m py_compile mysqlrecover_helper.py
npm pack --dry-run
```

## English

**mysql data recovery** reads MySQL binlog and writes rollback SQL files for table-level or SQL-level recovery. It never executes the rollback SQL and never creates or drops users automatically.

It supports local-time quick ranges (5/15/60 minutes), scan progress, SQL preview, temporary-user SQL with `PASSWORD EXPIRE INTERVAL 1 DAY`, and an “open SQL directory” action. See [docs/USAGE.md](docs/USAGE.md) for details.

## License

MIT. Third-party Python packages retain their own licenses.
