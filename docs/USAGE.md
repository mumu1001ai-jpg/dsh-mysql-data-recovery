# mysql数据恢复（dsh-mysql-data-recovery）

`dsh-mysql-data-recovery` 是一个 DSH 插件：在左侧 **mysql数据恢复** 工作区页面读取 MySQL binlog，生成**回滚 SQL 文件**。它不执行回滚 SQL，也不创建/删除用户。

## 使用

在 DSH 左侧工作区打开 **mysql数据恢复**：

1. 填写 MySQL Host、端口、库、表；
2. 选择模式：
   - **表级恢复**：回滚 SQL 执行的开始/结束时间 + INSERT/UPDATE/DELETE 类型（默认全选）；
   - **SQL级恢复**：执行过的 SQL + 回滚 SQL 执行的开始/结束时间；
3. 填写数据库用户和密码；
4. 点击“生成恢复 SQL”。

临时用户 SQL 与恢复 SQL 分开：
1. 在“临时恢复账号（可选）”中填写授权恢复表，例如 `shop.orders` 或 `shop.*`；也可以留空，使用下方恢复区域的 `database.table`；
2. 填写过期天数（默认 1 天）；如需固定用户名，在“指定临时用户名（留空随机）”中填写；`CREATE USER`、`GRANT`、`DROP USER` 都会使用这个用户名；
3. 生成时会**授予该恢复表的 SELECT 权限**（`db.table` 只授权单表，`db.*` 授权整库）；
4. 点击“生成临时用户 SQL”按钮；
3. 点击“打开临时用户 SQL 所在目录”，在资源管理器中打开并执行 CREATE USER / GRANT；
4. 再使用该账号生成恢复 SQL。

页面只显示恢复报告和预览，完整 SQL 写入文件。临时用户随机密码写入单独的 `*_temp_user.sql` 文件，不放在聊天页面中。

## 参数

| 字段 | 说明 |
| --- | --- |
| Host / 端口 | MySQL 地址，端口默认 3306 |
| 数据库 / 表 | 目标库和表 |
| 数据库用户 / 密码 | 恢复账号；推荐使用临时账号 |
| 模式 | **表级恢复** 或 **SQL级恢复** |
| 表级 DML 类型 | INSERT / UPDATE / DELETE，默认全选 |
| 回滚 SQL 执行的开始/结束时间 | 服务器本地时间，格式 `YYYY-MM-DD HH:MM:SS` |
| 执行过的 SQL | SQL级恢复时的目标 SQL |
| 临时用户 SQL | 在独立区域点击“生成临时用户 SQL”按钮生成；不自动执行 |
| 授权恢复表 | `db.table` 单表授权，或 `db.*` 整库授权；会授予 SELECT |
| 临时用户密码过期 | 默认 1 天，可改 |
| 预览条数 | 页面返回的 SQL 预览条数，默认 80 |

## 权限

恢复账号至少需要：

```sql
GRANT SELECT ON `your_db`.* TO 'recovery'@'%';
GRANT REPLICATION CLIENT ON *.* TO 'recovery'@'%';
GRANT REPLICATION SLAVE ON *.* TO 'recovery'@'%';
```

- `SELECT`：读取列名，生成回滚 SQL；
- `REPLICATION CLIENT`：`SHOW BINARY LOGS`；
- `REPLICATION SLAVE`：读取 binlog 事件流；
- 查看其他会话另需 `PROCESS`；
- MySQL 8.4 如提示 `REPLICATION SLAVE` 不可用，改用 `REPLICATION REPLICA`。

### 简化后的输出

生成恢复 SQL 时不再查询表信息、表大小或行数，不读取基础表数据。只返回：

- 回滚 SQL 文件路径；
- 匹配/生成的 SQL 条数；
- 已扫描事件数；
- SQL 预览。

时间默认取本地当前时间，并提供 **最近 5 分钟、最近 15 分钟、最近 1 小时** 快捷按钮。

生成过程中页面显示 `已扫描事件：N`，并显示扫描开始/结束时间；切换左侧页面后，非密码表单（主机、库表、时间、模式、临时用户字段）会保留，密码不会保存。

进度文件不是每 N 个事件强制写，而是最多每秒写一次；单次文件约几十字节并覆盖写，不会持续增长。扫描事件上限为 5,000,000，生成行数默认上限 20,000（最大 200,000）。

生成结果只显示 SQL 文件路径和预览，并提供“打开 SQL 所在目录”；临时用户 SQL 提供“打开临时用户 SQL 所在目录”。

### 只授权 REPLICATION、不授权 SELECT 可以吗？

**只读取原始 binlog 可以**：`REPLICATION CLIENT` + `REPLICATION SLAVE` 即可建立 binlog 复制流，复制协议本身不需要 `SELECT`。

**但本插件当前不能完全去掉 SELECT**：

- 需要读取列名来拼 `INSERT/UPDATE/DELETE`；
- MySQL 5.7 没有 binlog 列名元数据，没有 SELECT 时列名可能拿不到；
- 没有列名时生成的回滚 SQL 可能使用 `UNKNOWN_COL0` 或无法正确拼装。

如果一定要最小化权限，不要授 `SELECT ON *.*`，只授目标表：

```sql
GRANT SELECT ON `your_db`.`your_table` TO 'recovery'@'%';
GRANT REPLICATION CLIENT, REPLICATION SLAVE ON *.* TO 'recovery'@'%';
```

MySQL 8.0 开启 `binlog_row_metadata=FULL` 时部分列名可由 binlog 元数据提供，但不要把“只授 REPLICATION”作为当前插件的前置条件。

临时用户 SQL 由独立按钮写入单独的 `*_temp_user.sql` 文件，需由你在数据库中执行；恢复完成后执行对应的 `DROP USER`。如果临时用户是上一次生成的，可在独立区域填写同一个用户名并再次点击生成，得到只包含清理语句的文件。

### 临时用户 1 天后密码过期

页面默认生成：

```sql
CREATE USER 'tmp_recover_xxx'@'%'
  IDENTIFIED BY '随机密码'
  PASSWORD EXPIRE INTERVAL 1 DAY;
```

MySQL **5.7 和 8.0 都支持** `CREATE USER ... PASSWORD EXPIRE INTERVAL 1 DAY`，也支持 `ALTER USER ... PASSWORD EXPIRE INTERVAL 1 DAY`。

注意语义：

- 这是**密码有效期**，不是账号自动删除；
- 1 天后密码过期，客户端登录后通常只能执行重置密码相关操作，账号本身仍存在；
- 所以仍应在恢复完成后执行 `DROP USER IF EXISTS ...`；
- 如果确实要“1 天后自动删除账号”，MySQL 没有账号级 TTL，需要额外用 Event Scheduler 或外部定时任务执行 `DROP USER`。

页面“临时用户密码过期（天）”可改为其他天数；默认 1 天。

## 安全与限制

- **密码只在本页输入框和浏览器内存中**，通过本地 Host 用户命令 `mysqlrecover-ui` 传递；该命令设置 `recordInput:false`，所以命令参数（含密码）不写入 `command/run`，也不作为模型工具参数。切换到其他页面后密码会清除。**Host 命令仍会在本机会话日志中留下命令生命周期记录，需及时修改密码。**
- **数据恢复验证成功后，应及时执行 `DROP USER` 删除临时用户。**
- 页面不把数据库密码写进 SQL 文件或报告；恢复报告只包含 SQL 预览和文件路径。
- 临时用户随机密码写入单独的 `*_temp_user.sql` 文件，请限制该文件权限并及时删除。
- 浏览器页面、开发者工具和本机进程仍可看到输入内容；不要在不可信电脑上使用。
- 工具只生成 SQL，不执行 `INSERT/UPDATE/DELETE`，不自动创建/删除用户。
- 输出 SQL 完整写入文件；页面只显示前若干条，避免上万行 SQL 阻塞页面。
- SQL级恢复需要 `binlog_format=ROW`、`binlog_row_image=FULL`；目标 SQL 只解析简单 `AND` 等值、`IN`、`LIKE`，复杂 SQL 请缩小时间范围或改用表级恢复。
- 表级恢复从起始 binlog 文件 `pos=4` 扫描；时间窗口越大越慢。
- 生成的 SQL 必须在测试库或从库验证，并在事务中分批执行；大表不建议直接整段执行。
- 不处理 DDL 回滚；DDL 需从备份/表空间恢复。

## 运行依赖

DSH 的 Python 环境需安装：

```bash
python -m pip install pymysql mysql-replication
```

插件默认运行 `python`。如果 Python 不在 PATH，可设置：

```powershell
$env:DSH_MYSQLRECOVER_PYTHON = "C:\Python313\python.exe"
```

然后重启对应 DSH 会话。
