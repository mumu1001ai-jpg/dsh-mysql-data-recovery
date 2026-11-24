#!/usr/bin/env python3
"""Standalone MySQL binlog recovery planner used by the mysqlrecover DSH plugin.

It only reads metadata/binlog and writes a rollback SQL file.  It never executes
the generated rollback SQL and never creates/drops the temporary user.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import random
import re
import secrets
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    import pymysql
    from pymysql.converters import escape_item
    from pymysqlreplication import BinLogStreamReader
    from pymysqlreplication.event import QueryEvent, RotateEvent, XidEvent
    from pymysqlreplication.row_event import DeleteRowsEvent, UpdateRowsEvent, WriteRowsEvent
except Exception as exc:  # pragma: no cover - shown to the user
    print(
        "ERROR: mysqlrecover 依赖缺失。请在运行 DSH 的 Python 环境安装：\n"
        "  python -m pip install pymysql mysql-replication\n"
        f"原始错误：{exc}",
        file=sys.stderr,
    )
    raise SystemExit(2)

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


@dataclass
class Condition:
    column: str
    op: str
    value: Any


@dataclass
class Target:
    operation: str
    schema: str
    table: str
    conditions: list[Condition] = field(default_factory=list)
    match_all_values: dict[str, Any] = field(default_factory=dict)


@dataclass
class Record:
    op: str
    schema: str
    table: str
    file: str
    start_pos: int
    end_pos: int
    timestamp: dt.datetime
    sql: str


def qident(name: str) -> str:
    return "`" + str(name).replace("`", "``") + "`"


def qtable(schema: str, table: str) -> str:
    return f"{qident(schema)}.{qident(table)}"


def sql_lit(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bytes):
        return "_binary" + escape_item(value, "utf8mb4")
    return escape_item(value, "utf8mb4")


def clean_sql(text: str) -> str:
    text = (text or "").strip()
    text = re.sub(r"(?s)/\*.*?\*/", " ", text)
    text = re.sub(r"(?m)--[^\n]*", " ", text)
    return re.sub(r"\s+", " ", text).strip().rstrip(";")


def unquote_sql(value: str) -> Any:
    value = value.strip()
    if value.upper() == "NULL":
        return None
    if len(value) >= 2 and value[0] in ("'", '"') and value[-1] == value[0]:
        quote = value[0]
        body = value[1:-1]
        if quote == "'":
            body = body.replace("''", "'").replace("\\'", "'")
        return body
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        return value


def split_top(text: str, delimiter: str = ",") -> list[str]:
    parts: list[str] = []
    buf: list[str] = []
    depth = 0
    quote = ""
    i = 0
    while i < len(text):
        ch = text[i]
        if quote:
            buf.append(ch)
            if ch == "\\" and i + 1 < len(text):
                buf.append(text[i + 1])
                i += 2
                continue
            if ch == quote:
                if i + 1 < len(text) and text[i + 1] == quote:
                    buf.append(text[i + 1])
                    i += 2
                    continue
                quote = ""
            i += 1
            continue
        if ch in ("'", '"', "`"):
            quote = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        elif ch == delimiter and depth == 0:
            parts.append("".join(buf).strip())
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    parts.append("".join(buf).strip())
    return [p for p in parts if p]


def parse_table(raw: str) -> tuple[str, str]:
    bits = [x.strip("` ") for x in raw.strip().replace(" ", "").split(".") if x.strip()]
    if len(bits) >= 2:
        return bits[-2], bits[-1]
    return "", bits[-1] if bits else ""


def parse_target(sql: str, default_db: str) -> Target:
    raw = clean_sql(sql)
    m = re.match(r"(?is)^\s*(UPDATE|DELETE|INSERT)\b", raw)
    if not m:
        raise ValueError("按 SQL 恢复仅支持 UPDATE / DELETE / INSERT")
    op = m.group(1).upper()
    if op == "UPDATE":
        tm = re.search(r"(?is)^\s*UPDATE\s+([^\s]+)", raw)
    elif op == "DELETE":
        tm = re.search(r"(?is)\bFROM\s+([^\s]+)", raw)
    else:
        tm = re.search(r"(?is)\bINTO\s+([^\s]+)", raw)
    if not tm:
        raise ValueError("无法解析目标表")
    db, table = parse_table(tm.group(1))
    db = db or default_db
    if not db:
        raise ValueError("无法解析目标库，请在参数中填写 database")
    target = Target(op, db, table)
    if op == "INSERT":
        cm = re.search(r"(?is)\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)", raw)
        if cm:
            cols = [x.strip().strip("`") for x in split_top(cm.group(1))]
            vals = [unquote_sql(x) for x in split_top(cm.group(2))]
            target.match_all_values = dict(zip(cols, vals))
        else:
            raise ValueError("按 SQL 恢复 INSERT 时必须提供列名和 VALUES，例如 INSERT INTO t(a,b) VALUES(1,2)")
        return target
    wm = re.search(r"(?is)\bWHERE\b\s+(.+?)(?:\bLIMIT\b|\bORDER\s+BY\b|;|$)", raw)
    if not wm:
        raise ValueError(f"{op} 没有 WHERE 条件，拒绝生成大范围恢复 SQL")
    for raw_cond in split_top(wm.group(1).replace(" and ", " AND "), ","):
        for part in re.split(r"(?is)\s+AND\s+", raw_cond):
            part = part.strip()
            inm = re.match(r"(?is)^`?([A-Za-z0-9_$]+)`?\s+IN\s*\((.*)\)$", part)
            if inm:
                vals = [unquote_sql(x) for x in split_top(inm.group(2))]
                target.conditions.append(Condition(inm.group(1), "IN", vals))
                continue
            lm = re.match(r"(?is)^`?([A-Za-z0-9_$]+)`?\s+LIKE\s+(.+)$", part)
            if lm:
                target.conditions.append(Condition(lm.group(1), "LIKE", unquote_sql(lm.group(2))))
                continue
            em = re.match(r"(?is)^`?([A-Za-z0-9_$]+)`?\s*=\s*(.+)$", part)
            if em:
                target.conditions.append(Condition(em.group(1), "=", unquote_sql(em.group(2))))
    if not target.conditions:
        raise ValueError("WHERE 条件无法解析；请使用简单的 AND 等值 / IN / LIKE 条件")
    return target


def _like_regex(pattern: str) -> re.Pattern[str]:
    out = ""
    for ch in pattern:
        if ch == "%":
            out += ".*"
        elif ch == "_":
            out += "."
        else:
            out += re.escape(ch)
    return re.compile("^" + out + "$", re.I | re.S)


def condition_matches(conds: list[Condition], row: dict[str, Any]) -> bool:
    for c in conds:
        actual = row.get(c.column)
        if c.op == "IN":
            if not any(str(actual) == str(v) for v in c.value):
                return False
        elif c.op == "LIKE":
            if not _like_regex(str(c.value)).match(str(actual or "")):
                return False
        else:
            if str(actual) != str(c.value):
                return False
    return True


def parse_dt(text: str, field_name: str) -> dt.datetime:
    text = (text or "").strip()
    if not text:
        raise ValueError(f"{field_name} 不能为空")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime(text, fmt)
        except ValueError:
            pass
    try:
        return dt.datetime.fromisoformat(text.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError as exc:
        raise ValueError(f"{field_name} 格式应为 YYYY-MM-DD HH:MM:SS") from exc


def connect(cfg: dict[str, Any]) -> pymysql.connections.Connection:
    return pymysql.connect(
        host=str(cfg.get("host") or ""),
        port=int(cfg.get("port") or 3306),
        user=str(cfg.get("user") or ""),
        password=str(cfg.get("password") or ""),
        database=str(cfg.get("database") or "") or None,
        connect_timeout=8,
        read_timeout=30,
        write_timeout=30,
        charset="utf8mb4",
        autocommit=True,
        cursorclass=pymysql.cursors.DictCursor,
    )


def binlog_files(conn) -> list[str]:
    with conn.cursor() as cur:
        try:
            cur.execute("SHOW BINARY LOGS")
        except Exception:
            cur.execute("SHOW MASTER LOGS")
        rows = cur.fetchall()
    names = []
    for row in rows:
        name = row.get("Log_name") or row.get("File") or next(iter(row.values()))
        if name:
            names.append(str(name))
    return sorted(names)


def where_items(values: dict[str, Any]) -> str:
    parts = []
    for key, value in values.items():
        if value is None:
            parts.append(f"{qident(key)} IS NULL")
        else:
            parts.append(f"{qident(key)} = {sql_lit(value)}")
    return " AND ".join(parts)


def reverse_sql(event: Any, row: dict[str, Any], schema: str, table: str) -> str:
    if isinstance(event, WriteRowsEvent):
        values = row.get("values") or {}
        return f"DELETE FROM {qtable(schema, table)} WHERE {where_items(values)} LIMIT 1;"
    if isinstance(event, DeleteRowsEvent):
        values = row.get("values") or {}
        cols = ", ".join(qident(k) for k in values)
        vals = ", ".join(sql_lit(v) for v in values.values())
        return f"INSERT INTO {qtable(schema, table)} ({cols}) VALUES ({vals});"
    if isinstance(event, UpdateRowsEvent):
        before = row.get("before_values") or {}
        after = row.get("after_values") or {}
        set_clause = ", ".join(f"{qident(k)} = {sql_lit(v)}" for k, v in before.items())
        return f"UPDATE {qtable(schema, table)} SET {set_clause} WHERE {where_items(after)} LIMIT 1;"
    return ""


def op_name(event: Any) -> str:
    if isinstance(event, WriteRowsEvent):
        return "INSERT"
    if isinstance(event, DeleteRowsEvent):
        return "DELETE"
    if isinstance(event, UpdateRowsEvent):
        return "UPDATE"
    return ""


def output_file(cfg: dict[str, Any], db: str, table: str) -> Path:
    base = (cfg.get("output_dir") or "").strip()
    directory = Path(base).expanduser() if base else Path(tempfile.gettempdir()) / "mysqlrecover"
    directory.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", f"{db}_{table}")[:80]
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    return directory / f"mysqlrecover_{safe}_{stamp}.sql"


def parse_grant_target(raw: str, default_db: str = "") -> tuple[str, str, str]:
    text = str(raw or "").strip().strip("`")
    if not text:
        if default_db:
            text = default_db + ".*"
        else:
            raise ValueError("请填写授权恢复表，例如 shop.orders 或 shop.*")
    if "." in text:
        schema, obj = text.split(".", 1)
    else:
        schema, obj = default_db, text
    schema = schema.strip().strip("`")
    obj = obj.strip().strip("`")
    if not schema or not obj:
        raise ValueError("授权对象格式应为 db.table 或 db.*")
    if any(ch in schema for ch in " \t\r\n") or any(ch in obj for ch in " \t\r\n"):
        raise ValueError("授权对象不能包含空白字符")
    if obj == "*":
        return schema, "*", f"{qident(schema)}.*"
    return schema, obj, f"{qident(schema)}.{qident(obj)}"


def make_temp_user(cfg: dict[str, Any], grant_target: str) -> tuple[str, str, str]:
    user = str(cfg.get("temp_user_name") or "").strip()
    password = str(cfg.get("temp_password") or "").strip()
    if not user:
        user = "tmp_recover_" + secrets.token_hex(4)
    if not password:
        password = secrets.token_urlsafe(18)
    try:
        days = max(1, min(365, int(cfg.get("temp_user_expire_days") or 1)))
    except (TypeError, ValueError):
        days = 1
    user_lit = "'" + user.replace("'", "''") + "'"
    pass_lit = "'" + password.replace("'", "''") + "'"
    create = (
        f"CREATE USER {user_lit}@'%' IDENTIFIED BY {pass_lit} "
        f"PASSWORD EXPIRE INTERVAL {days} DAY;\n"
        f"GRANT REPLICATION CLIENT, REPLICATION SLAVE ON *.* TO {user_lit}@'%';\n"
        f"GRANT SELECT ON {grant_target} TO {user_lit}@'%';"
    )
    drop = f"DROP USER IF EXISTS {user_lit}@'%';"
    return user, create, drop


def build_report(cfg: dict[str, Any]) -> str:
    host = str(cfg.get("host") or "").strip()
    port = int(cfg.get("port") or 3306)
    db = str(cfg.get("database") or "").strip()
    table = str(cfg.get("table") or "").strip()
    user = str(cfg.get("user") or "").strip()
    mode = str(cfg.get("mode") or "table").lower()
    if mode == "time":
        mode = "table"
    if not host or not db or not table or not user:
        raise ValueError("host、database、table、user 不能为空")
    if mode == "table":
        start = parse_dt(str(cfg.get("start_time") or ""), "start_time")
        end = parse_dt(str(cfg.get("end_time") or ""), "end_time")
        if end <= start:
            raise ValueError("end_time 必须晚于 start_time")
        requested_types = cfg.get("sql_types") or ["INSERT", "UPDATE", "DELETE"]
        types = {str(x).upper() for x in requested_types if str(x).strip()}
        if not types:
            raise ValueError("表级恢复至少选择一种 DML 类型（INSERT/UPDATE/DELETE）")
        if not types <= {"INSERT", "UPDATE", "DELETE"}:
            raise ValueError("sql_types 只支持 INSERT/UPDATE/DELETE")
        target = None
    elif mode == "sql":
        target_sql = str(cfg.get("target_sql") or "").strip()
        if not target_sql:
            raise ValueError("SQL级恢复必须提供执行过的 SQL")
        start = parse_dt(str(cfg.get("start_time") or ""), "start_time")
        end = parse_dt(str(cfg.get("end_time") or ""), "end_time")
        if end <= start:
            raise ValueError("end_time 必须晚于 start_time")
        target = parse_target(target_sql, db)
        db = target.schema
        table = target.table
        types = {target.operation}
    else:
        raise ValueError("mode 必须是 table 或 sql")

    conn = connect(cfg)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT VERSION(), @@binlog_format, @@binlog_row_image")
            version_row = cur.fetchone() or {}
            version = str(version_row.get("VERSION()") or "")
            fmt = str(version_row.get("@@binlog_format") or "")
            image = str(version_row.get("@@binlog_row_image") or "")
        if fmt.upper() != "ROW":
            raise ValueError(f"binlog_format={fmt}，恢复必须为 ROW")
        if image.upper() != "FULL":
            raise ValueError(f"binlog_row_image={image}，按 SQL 恢复/完整行回滚需要 FULL")
        files = binlog_files(conn)
        profile = {
            "host": host, "port": port, "user": user, "passwd": str(cfg.get("password") or ""),
            "charset": "utf8mb4",
        }
        # first_event_timestamp needs a working profile; inline the binary search.
        def file_time(name: str) -> dt.datetime | None:
            reader = None
            try:
                reader = BinLogStreamReader(
                    connection_settings=profile,
                    server_id=random.randint(100000000, 200000000),
                    log_file=name,
                    log_pos=4,
                    blocking=False,
                    resume_stream=True,
                    use_column_name_cache=True,
                    enable_logging=False,
                )
                for _ in range(200):
                    event = next(iter(reader), None)
                    if event is None:
                        break
                    ts = getattr(event, "timestamp", 0)
                    if ts:
                        return dt.datetime.fromtimestamp(ts)
            except Exception:
                return None
            finally:
                if reader is not None:
                    try:
                        reader.close()
                    except Exception:
                        pass
            return None

        lo, hi, best = 0, len(files) - 1, 0
        while lo <= hi:
            mid = (lo + hi) // 2
            ts = file_time(files[mid])
            if ts is None or ts <= start:
                best, lo = mid, mid + 1
            else:
                hi = mid - 1
        start_file = files[best]

        records: list[Record] = []
        warnings: list[str] = []
        max_rows = max(10, min(200000, int(cfg.get("max_rows") or 20000)))
        max_events = 5_000_000
        scanned = 0
        progress_file = str(cfg.get("progress_file") or "").strip()
        last_progress_at = 0.0

        def emit_progress(done: bool = False, error: str = "", force: bool = False) -> None:
            nonlocal last_progress_at
            if not progress_file:
                return
            now = time.monotonic()
            if not force and now - last_progress_at < 1.0:
                return
            try:
                Path(progress_file).write_text(json.dumps({
                    "scanned": scanned,
                    "records": len(records),
                    "done": done,
                    "error": error,
                }, ensure_ascii=False), encoding="utf-8")
                last_progress_at = now
            except Exception:
                pass

        emit_progress(force=True)
        last_pos = 4
        txn_start = 4
        current_file = start_file
        reader = BinLogStreamReader(
            connection_settings=profile,
            server_id=random.randint(100000000, 200000000),
            log_file=start_file,
            log_pos=4,
            blocking=False,
            resume_stream=True,
            only_schemas=[db],
            only_tables=[table],
            use_column_name_cache=True,
            enable_logging=False,
        )
        try:
            for event in reader:
                scanned += 1
                if scanned % 256 == 0:
                    emit_progress()
                if scanned >= max_events or len(records) >= max_rows:
                    warnings.append(f"达到上限：events={max_events}, rows={max_rows}；请缩小时间范围")
                    break
                current_file = str(getattr(reader, "log_file", current_file) or current_file)
                ts = getattr(event, "timestamp", 0)
                event_time = dt.datetime.fromtimestamp(ts) if ts else None
                pos = int(getattr(getattr(event, "packet", None), "log_pos", 0) or 0)
                if event_time is not None and event_time > end:
                    break
                if isinstance(event, QueryEvent) and str(event.query or "").strip().upper() == "BEGIN":
                    txn_start = last_pos
                if event_time is not None and event_time >= start and hasattr(event, "rows"):
                    schema = str(getattr(event, "schema", "") or "")
                    table_name = str(getattr(event, "table", "") or "")
                    if schema.lower() != db.lower() or table_name.lower() != table.lower():
                        last_pos = pos or last_pos
                        continue
                    op = op_name(event)
                    if not op:
                        last_pos = pos or last_pos
                        continue
                    if target is None and op not in types:
                        last_pos = pos or last_pos
                        continue
                    for row in list(getattr(event, "rows", []) or []):
                        if target is not None:
                            if op != target.operation:
                                continue
                            values = row.get("before_values") if op == "UPDATE" else (row.get("values") or {})
                            if target.operation == "INSERT" and target.match_all_values:
                                if any(str(values.get(k)) != str(v) for k, v in target.match_all_values.items()):
                                    continue
                            elif target.conditions and not condition_matches(target.conditions, values or {}):
                                continue
                        sql = reverse_sql(event, row, schema, table_name)
                        if not sql:
                            continue
                        records.append(Record(op, schema, table_name, current_file, txn_start or last_pos, pos, event_time or start, sql))
                        if len(records) >= max_rows:
                            break
                if not isinstance(event, (RotateEvent,)):
                    last_pos = pos or last_pos
        finally:
            try:
                reader.close()
            except Exception:
                pass

        records.reverse()
        path = output_file(cfg, db, table)
        preview_limit = max(10, min(500, int(cfg.get("preview_rows") or 80)))
        preview = [r.sql for r in records[:preview_limit]]
        with path.open("w", encoding="utf-8") as fh:
            fh.write("-- mysqlrecover rollback SQL\n")
            fh.write(f"-- source: {host}:{port} / {db}.{table}\n")
            fh.write(f"-- mode: {mode}; {start:%Y-%m-%d %H:%M:%S} ~ {end:%Y-%m-%d %H:%M:%S}\n")
            fh.write("-- review and test before executing; execute in a transaction and commit in batches\n")
            if warnings:
                for w in warnings:
                    fh.write(f"-- WARNING: {w}\n")
            fh.write("\n")
            for record in records:
                fh.write(f"-- {record.op} {record.file} start {record.start_pos} end {record.end_pos} {record.timestamp:%Y-%m-%d %H:%M:%S}\n")
                fh.write(record.sql + "\n")
        emit_progress(done=True, force=True)
        lines = [
            "=== mysqlrecover 回滚 SQL ===",
            f"SQL 文件：{path}",
            f"匹配/生成 SQL：{len(records)} 条；扫描事件：{scanned}",
        ]
        if warnings:
            lines += ["", "警告："] + [f"- {w}" for w in warnings]
        lines += ["", f"预览（前 {len(preview)} 条，完整内容见文件）："]
        lines += preview if preview else ["(没有匹配的 DML 事件)"]
        if len(records) > len(preview):
            lines.append(f"... 还有 {len(records)-len(preview)} 条未在预览中显示；请打开 SQL 文件查看。")
        lines += ["", "本插件只生成 SQL，不会自动执行回滚 SQL，也不会自动创建/删除用户。"]
        return "\n".join(lines)
    finally:
        conn.close()


def build_temp_user(cfg: dict[str, Any]) -> str:
    default_db = str(cfg.get("database") or "").strip()
    grant_raw = str(cfg.get("grant_target") or "").strip()
    schema, grant_table, grant_target = parse_grant_target(grant_raw, default_db)
    user, create_sql, drop_sql = make_temp_user(cfg, grant_target)
    try:
        days = max(1, min(365, int(cfg.get("temp_user_expire_days") or 1)))
    except (TypeError, ValueError):
        days = 1
    path = output_file(cfg, schema, f"temp_user_{user}")
    with path.open("w", encoding="utf-8") as fh:
        fh.write("-- mysqlrecover temporary recovery user\n")
        fh.write(f"-- generated at {dt.datetime.now():%Y-%m-%d %H:%M:%S}\n")
        fh.write("-- restrict this file's permissions; it contains a generated password\n\n")
        fh.write(create_sql + "\n")
        fh.write("\n-- cleanup after recovery\n")
        fh.write(drop_sql + "\n")
    return "\n".join([
        "=== mysqlrecover 临时用户 SQL ===",
        f"临时用户：{user}",
        f"授权恢复表：{grant_target}（会授予该对象的 SELECT 权限）",
        f"密码策略：PASSWORD EXPIRE INTERVAL {days} DAY（到期后密码过期，不是账号自动删除）。",
        f"临时用户 SQL 文件：{path}",
        "请打开该文件，先执行 CREATE USER / GRANT，再使用该账号。",
        "恢复完成后执行：",
        drop_sql,
        "文件包含随机密码，请限制权限并及时删除。",
    ])


def main() -> int:
    try:
        raw = sys.stdin.read()
        cfg = json.loads(raw or "{}")
        if str(cfg.get("action") or "recover") == "temp_user":
            print(build_temp_user(cfg))
        else:
            print(build_report(cfg))
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
