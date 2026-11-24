# Changelog

## 1.5.0

- Rename the plugin display name to **mysql数据恢复**.
- Rename the npm package to `dsh-mysql-data-recovery`.
- Add npm/GitHub packaging metadata, MIT license, changelog, and GitHub Actions publishing workflow.
- Add a plugin detail preview and keep the long-form guide in `docs/USAGE.md`.
- Keep the latest UI fixes: local-time shortcuts, scan progress/start/end, persisted non-secret form state, blue directory buttons, and no table-size display.

## 1.4.2

- Remove the unreliable local-file link for temporary-user SQL.
- Make directory buttons blue and keep native Explorer/Finder/xdg-open fallback.

## 1.4.1

- Add the password-cleared/temporary-user cleanup security notice.
- Prefer DSH native path reveal for “open directory”, with an Explorer fallback.

## 1.4.0

- Preserve non-secret form fields across page switches.
- Add scan start/end times and “open SQL directory”.
- Filter binlog reading with `only_schemas`/`only_tables`.
- Remove table info/size and backup suggestions from output.

## Earlier

- Table-level and SQL-level recovery.
- Temporary-user SQL with `PASSWORD EXPIRE INTERVAL 1 DAY`.
- Time-based progress writes, quick ranges, and SQL preview.
