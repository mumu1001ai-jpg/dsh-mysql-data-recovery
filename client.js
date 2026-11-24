window.__ModuleLoader__.load({
  id: 'dsh-mysql-data-recovery',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const C = {
      bg: 'var(--dsw-alias-bg-primary, #08111f)',
      card: 'var(--dsw-alias-bg-secondary, #0f1c2e)',
      border: 'var(--dsw-alias-border, #263b54)',
      text: 'var(--dsw-alias-text-primary, #e6eef9)',
      muted: 'var(--dsw-alias-text-secondary, #9fb3c8)',
      accent: 'var(--dsw-alias-accent, #38bdf8)',
      danger: 'var(--dsw-alias-text-danger, #fb7185)',
      ok: 'var(--dsw-alias-text-success, #34d399)',
    };

    const css = {
      page: { height: '100%', overflow: 'auto', boxSizing: 'border-box', padding: '28px 30px 40px', color: C.text, background: C.bg, font: '14px/1.55 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif' },
      head: { display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 },
      title: { margin: 0, fontSize: 24, fontWeight: 700 },
      sub: { color: C.muted, fontSize: 13, marginBottom: 20 },
      h2: { margin: '0 0 6px', fontSize: 16, fontWeight: 700 },
      warn: { border: '1px solid #7c5a1d', background: '#251b0b', color: '#fbbf24', borderRadius: 8, padding: '10px 12px', fontSize: 13, marginBottom: 16, whiteSpace: 'pre-wrap' },
      card: { border: `1px solid ${C.border}`, background: C.card, borderRadius: 10, padding: 16, marginBottom: 14 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 },
      field: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 },
      label: { color: C.muted, fontSize: 12 },
      input: { boxSizing: 'border-box', width: '100%', padding: '8px 10px', borderRadius: 6, border: `1px solid ${C.border}`, background: '#071521', color: C.text, outline: 'none' },
      textarea: { boxSizing: 'border-box', width: '100%', minHeight: 82, resize: 'vertical', padding: '8px 10px', borderRadius: 6, border: `1px solid ${C.border}`, background: '#071521', color: C.text, fontFamily: 'ui-monospace, monospace', fontSize: 12 },
      row: { display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginTop: 14 },
      button: { border: 0, borderRadius: 6, padding: '9px 16px', background: C.accent, color: '#04121f', fontWeight: 700, cursor: 'pointer' },
      button2: { border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 12px', background: 'transparent', color: C.muted, cursor: 'pointer' },
      error: { color: C.danger, whiteSpace: 'pre-wrap', marginTop: 12 },
      report: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: 1.5, background: '#071521', border: `1px solid ${C.border}`, borderRadius: 8, padding: 12, maxHeight: '48vh', overflow: 'auto', marginTop: 12 },
    };

    function useSessions(ctx) {
      const [snap, setSnap] = React.useState(() => ctx.sessions.list.getSnapshot());
      React.useEffect(() => ctx.sessions.list.subscribe(() => setSnap(ctx.sessions.list.getSnapshot())), [ctx]);
      return snap;
    }

    function localStamp(date) {
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    function recentRange(minutes) {
      const end = new Date();
      const start = new Date(end.getTime() - minutes * 60 * 1000);
      return [localStamp(start), localStamp(end)];
    }

    function loadSavedForm() {
      try {
        return JSON.parse(sessionStorage.getItem('mysqlrecover-form') || '{}') || {};
      } catch {
        return {};
      }
    }

    function Field({ label, children }) {
      return h('label', { style: css.field }, h('span', { style: css.label }, label), children);
    }

    function Page({ ctx }) {
      const saved = React.useMemo(loadSavedForm, []);
      const [host, setHost] = React.useState(saved.host || '');
      const [port, setPort] = React.useState(saved.port || '3306');
      const [database, setDatabase] = React.useState(saved.database || '');
      const [table, setTable] = React.useState(saved.table || '');
      const [user, setUser] = React.useState(saved.user || '');
      const [password, setPassword] = React.useState('');
      const [mode, setMode] = React.useState(saved.mode === 'sql' ? 'sql' : 'table');
      const [start, setStart] = React.useState(saved.start || '');
      const [end, setEnd] = React.useState(saved.end || '');
      const [targetSql, setTargetSql] = React.useState(saved.targetSql || '');
      const [types, setTypes] = React.useState(saved.types || { INSERT: true, UPDATE: true, DELETE: true });
      const [tempUserName, setTempUserName] = React.useState(saved.tempUserName || '');
      const [tempGrant, setTempGrant] = React.useState(saved.tempGrant || '');
      const [tempExpireDays, setTempExpireDays] = React.useState(saved.tempExpireDays || '1');
      const [tempBusy, setTempBusy] = React.useState(false);
      const [tempReport, setTempReport] = React.useState('');
      const [tempError, setTempError] = React.useState('');
      const [tempFile, setTempFile] = React.useState('');
      const [previewRows, setPreviewRows] = React.useState(saved.previewRows || '80');
      const [busy, setBusy] = React.useState(false);
      const [report, setReport] = React.useState('');
      const [error, setError] = React.useState('');
      const [scanned, setScanned] = React.useState(0);
      const [scanStart, setScanStart] = React.useState('');
      const [scanEnd, setScanEnd] = React.useState('');
      const [sqlFile, setSqlFile] = React.useState('');
      const pollRef = React.useRef(null);
      const snap = useSessions(ctx);
      const sessionIds = snap.ids || [];
      const effectiveSession = sessionIds[0] || '';

      React.useEffect(() => {
        if (!saved.start || !saved.end) {
          const [s, e] = recentRange(5);
          setStart(s);
          setEnd(e);
        }
        return () => {
          if (pollRef.current) clearInterval(pollRef.current);
        };
      }, []);

      React.useEffect(() => {
        try {
          sessionStorage.setItem('mysqlrecover-form', JSON.stringify({
            host, port, database, table, user, mode, start, end, targetSql, types,
            tempUserName, tempGrant, tempExpireDays, previewRows,
          }));
        } catch {
          /* ignore storage errors */
        }
      }, [host, port, database, table, user, mode, start, end, targetSql, types,
        tempUserName, tempGrant, tempExpireDays, previewRows]);

      const disabled = busy || !effectiveSession;

      function stopProgress() {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }

      function startProgress(jobId) {
        stopProgress();
        setScanned(0);
        pollRef.current = setInterval(async () => {
          try {
            const response = await fetch(`/mysqlrecover/progress?job=${encodeURIComponent(jobId)}`, { cache: 'no-store' });
            if (!response.ok) return;
            const data = await response.json();
            if (typeof data.scanned === 'number') setScanned(data.scanned);
          } catch {
            /* progress is best-effort */
          }
        }, 1000);
      }

      async function generate(event) {
        if (event) event.preventDefault();
        setError('');
        setReport('');
        setScanStart(localStamp(new Date()));
        setScanEnd('');
        setSqlFile('');
        if (!effectiveSession) {
          setError('没有可用于承载 Host 命令的会话；请先创建一个会话。');
          return;
        }
        if (!host || !database || !table || !user || !password) {
          setError('host、database、table、user、password 不能为空。');
          return;
        }
        if (!start || !end) {
          setError('start_time 和 end_time 不能为空。');
          return;
        }
        if (mode === 'sql' && !targetSql.trim()) {
          setError('SQL级恢复必须填写“执行过的 SQL”。');
          return;
        }
        if (mode === 'table' && !types.INSERT && !types.UPDATE && !types.DELETE) {
          setError('表级恢复至少选择 INSERT、UPDATE、DELETE 中的一种。');
          return;
        }
        const jobId = 'mr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
        const payload = {
          action: 'recover',
          job_id: jobId,
          host, port: Number(port) || 3306, database, table, user, password, mode,
          start_time: start, end_time: end, target_sql: targetSql,
          sql_types: Object.keys(types).filter(k => types[k]),
          preview_rows: Number(previewRows) || 80, max_rows: 20000,
        };
        setBusy(true);
        startProgress(jobId);
        try {
          const line = '/mysqlrecover-ui ' + JSON.stringify(payload);
          const remote = await ctx.remote.commands.execute(effectiveSession, line, []);
          if (!remote.ok) {
            setError('Host 命令失败：' + remote.error.code + ' ' + remote.error.message);
            return;
          }
          const value = remote.value;
          if (!value) {
            setError('Host 没有找到 mysqlrecover-ui 命令；请确认插件已启用。');
            return;
          }
          const result = value.result;
          if (!result || result.kind === 'error') {
            setError((result && result.text) || '恢复计划生成失败');
            return;
          }
          const text = result.text || '完成';
          setReport(text);
          const fileMatch = text.match(/^SQL 文件[：:]\s*(.+)$/m);
          if (fileMatch) setSqlFile(fileMatch[1].trim());
          setScanEnd(localStamp(new Date()));
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        } finally {
          stopProgress();
          setScanEnd(previous => previous || localStamp(new Date()));
          setBusy(false);
        }
      }

      async function generateTemp(event) {
        if (event) event.preventDefault();
        setTempError('');
        setTempReport('');
        setTempFile('');
        if (!effectiveSession) {
          setTempError('没有可用于承载 Host 命令的会话；请先创建一个会话。');
          return;
        }
        const fallbackGrant = database.trim() && table.trim() ? `${database.trim()}.${table.trim()}` : '';
        const grantTarget = tempGrant.trim() || fallbackGrant;
        if (!grantTarget) {
          setTempError('请填写授权恢复表，例如 shop.orders 或 shop.*');
          return;
        }
        const payload = {
          action: 'temp_user',
          database: database.trim(),
          grant_target: grantTarget,
          temp_user_name: tempUserName.trim(),
          temp_user_expire_days: Number(tempExpireDays) || 1,
        };
        setTempBusy(true);
        try {
          const line = '/mysqlrecover-ui ' + JSON.stringify(payload);
          const remote = await ctx.remote.commands.execute(effectiveSession, line, []);
          if (!remote.ok) {
            setTempError('Host 命令失败：' + remote.error.code + ' ' + remote.error.message);
            return;
          }
          const value = remote.value;
          if (!value) {
            setTempError('Host 没有找到 mysqlrecover-ui 命令；请确认插件已启用。');
            return;
          }
          const result = value.result;
          if (!result || result.kind === 'error') {
            setTempError((result && result.text) || '临时用户 SQL 生成失败');
            return;
          }
          const text = result.text || '';
          setTempReport(text);
          const match = text.match(/临时用户 SQL 文件[：:]\s*(.+)/);
          if (match) setTempFile(match[1].trim().replace(/\r$/, ''));
        } catch (e) {
          setTempError(String(e && e.message ? e.message : e));
        } finally {
          setTempBusy(false);
        }
      }

      async function openFolder(targetPath) {
        if (!targetPath || !effectiveSession) return;
        try {
          const line = '/mysqlrecover-ui ' + JSON.stringify({ action: 'open_dir', path: targetPath });
          const remote = await ctx.remote.commands.execute(effectiveSession, line, []);
          if (!remote.ok) {
            setError('打开目录失败：' + remote.error.code + ' ' + remote.error.message);
          } else if (remote.value && remote.value.result && remote.value.result.kind === 'error') {
            setError('打开目录失败：' + remote.value.result.text);
          }
        } catch (e) {
          setError('打开目录失败：' + String(e));
        }
      }

      async function copyReport() {
        try {
          await navigator.clipboard.writeText(report);
        } catch (e) {
          setError('复制失败：' + String(e));
        }
      }

      return h('div', { style: css.page },
        h('div', { style: css.head }, h('h1', { style: css.title }, 'mysql数据恢复'), h('span', { style: { color: C.muted, fontSize: 12 } }, 'v1.5.0')),
        h('div', { style: css.sub }, '按时间或目标 SQL 读取 binlog，生成回滚 SQL 文件；不会执行回滚，也不会自动创建/删除用户。'),
        h('div', { style: css.warn },
          '安全提示：密码只在本页输入，通过 Host 用户命令传递，不作为模型工具参数，也不会写进报告。切换到其他页面后密码会清除。\n' +
          'Host 命令仍会在本机会话日志中留下命令生命周期记录，需及时修改密码。\n' +
          '数据恢复验证成功后，应及时执行 DROP USER 删除临时用户。'),
        h('div', { style: css.card },
          h('h2', { style: css.h2 }, '1. 临时恢复账号（可选）'),
          h('div', { style: { color: C.muted, fontSize: 12, marginBottom: 10 } }, '单独生成 CREATE USER / GRANT / DROP USER SQL 文件；不连接数据库，也不生成恢复 SQL。'),
          h('div', { style: css.grid },
            h(Field, { label: '指定临时用户名（留空随机）' }, h('input', { style: css.input, value: tempUserName, onChange: e => setTempUserName(e.target.value), placeholder: '例如 tmp1124' })),
            h(Field, { label: '授权恢复表（db.table 或 db.*）' }, h('input', { style: css.input, value: tempGrant, onChange: e => setTempGrant(e.target.value), placeholder: '例如 shop.orders 或 shop.*' })),
            h(Field, { label: '密码过期（天）' }, h('input', { style: css.input, value: tempExpireDays, onChange: e => setTempExpireDays(e.target.value), placeholder: '1' })),
          ),
          h('div', { style: { color: C.muted, fontSize: 12, marginTop: 8 } },
            '将授予该恢复表的 SELECT 权限；也可填写 db.* 授权整库。' +
            ' · 将创建：' + (tempUserName.trim() || '随机用户名')),
          h('div', { style: css.row },
            h('button', { type: 'button', style: { ...css.button, opacity: (tempBusy || !effectiveSession) ? 0.5 : 1 }, disabled: tempBusy || !effectiveSession, onClick: generateTemp }, tempBusy ? '生成中…' : '生成临时用户 SQL'),
          ),
          tempError ? h('div', { style: css.error }, tempError) : null,
          tempFile ? h('div', { style: css.row },
            h('button', { type: 'button', style: css.button, onClick: () => openFolder(tempFile) }, '打开临时用户 SQL 所在目录'),
            h('span', { style: { color: C.muted, fontSize: 12, overflowWrap: 'anywhere' } }, tempFile),
          ) : null,
          tempReport ? h('pre', { style: css.report }, tempReport) : null,
        ),
        h('form', { onSubmit: generate },
          h('div', { style: css.card },
            h('h2', { style: css.h2 }, '2. 生成恢复 SQL'),
            h('div', { style: { color: C.muted, fontSize: 12, marginBottom: 10 } }, '使用已有账号或上面生成的临时账号；不包含临时用户 SQL。'),
            h('div', { style: css.grid },
              h(Field, { label: 'MySQL Host' }, h('input', { style: css.input, value: host, onChange: e => setHost(e.target.value), placeholder: '10.0.0.12', autoComplete: 'off' })),
              h(Field, { label: '端口' }, h('input', { style: css.input, value: port, onChange: e => setPort(e.target.value), placeholder: '3306' })),
              h(Field, { label: '数据库' }, h('input', { style: css.input, value: database, onChange: e => setDatabase(e.target.value), placeholder: 'shop' })),
              h(Field, { label: '表名' }, h('input', { style: css.input, value: table, onChange: e => setTable(e.target.value), placeholder: 'orders' })),
              h(Field, { label: '数据库用户' }, h('input', { style: css.input, value: user, onChange: e => setUser(e.target.value), placeholder: 'tmp_recover', autoComplete: 'username' })),
              h(Field, { label: '数据库密码' }, h('input', { style: css.input, type: 'password', value: password, onChange: e => setPassword(e.target.value), placeholder: '只在本页输入', autoComplete: 'new-password' })),
              h(Field, { label: '恢复模式' },
                h('select', { style: css.input, value: mode, onChange: e => setMode(e.target.value) },
                  h('option', { value: 'table' }, '表级恢复（按时间）'),
                  h('option', { value: 'sql' }, 'SQL级恢复（执行过的 SQL）'))),
              h(Field, { label: '回滚 SQL 执行的开始时间' }, h('input', { style: css.input, value: start, onChange: e => setStart(e.target.value), placeholder: '2026-11-23 10:00:00' })),
              h(Field, { label: '回滚 SQL 执行的结束时间' }, h('input', { style: css.input, value: end, onChange: e => setEnd(e.target.value), placeholder: '2026-11-23 10:05:00' })),
            ),
            h('div', { style: css.row },
              h('span', { style: { color: C.muted, fontSize: 12 } }, '快捷时间（本地当前时间）'),
              [5, 15, 60].map(minutes => h('button', {
                key: minutes, type: 'button', style: css.button2,
                onClick: () => {
                  const [s, e] = recentRange(minutes);
                  setStart(s);
                  setEnd(e);
                },
              }, minutes < 60 ? `最近 ${minutes} 分钟` : '最近 1 小时')),
            ),
            mode === 'table' ? h('div', { style: css.row },
              h('span', { style: { color: C.muted, fontSize: 12 } }, '表级 DML 类型（默认全选）'),
              ['INSERT', 'UPDATE', 'DELETE'].map(kind => h('label', { key: kind, style: { display: 'flex', gap: 5, alignItems: 'center', color: C.muted, fontSize: 12 } },
                h('input', { type: 'checkbox', checked: types[kind], onChange: e => setTypes({ ...types, [kind]: e.target.checked }) }),
                kind)),
            ) : null,
            mode === 'sql' ? h('div', { style: { marginTop: 12 } }, h(Field, { label: '执行过的 SQL（支持简单 AND 等值 / IN / LIKE）' }, h('textarea', { style: css.textarea, value: targetSql, onChange: e => setTargetSql(e.target.value), placeholder: "UPDATE orders SET status='x' WHERE id=123" }))) : null,
            h('div', { style: css.row },
              h(Field, { label: '预览条数' },
                h('input', { style: { ...css.input, width: 70 }, value: previewRows, onChange: e => setPreviewRows(e.target.value) })),
              h('button', { type: 'submit', style: { ...css.button, opacity: disabled ? 0.5 : 1 }, disabled }, busy ? '生成中…' : '生成恢复 SQL'),
              busy ? h('span', { style: { color: C.muted, fontSize: 12 } }, `已扫描事件：${scanned}`) : null,
              report ? h('button', { type: 'button', style: css.button2, onClick: copyReport }, '复制报告') : null)),
          ),
        scanStart ? h('div', { style: { color: C.muted, fontSize: 12, marginTop: 8 } },
          `扫描开始：${scanStart}` + (scanEnd ? `　扫描结束：${scanEnd}` : '')) : null,
        error ? h('div', { style: css.error }, error) : null,
        report ? h('div', { style: css.card },
          sqlFile ? h('div', { style: css.row },
            h('button', { type: 'button', style: css.button, onClick: () => openFolder(sqlFile) }, '打开 SQL 所在目录'),
            h('span', { style: { color: C.muted, fontSize: 12, overflowWrap: 'anywhere' } }, sqlFile),
          ) : null,
          h('pre', { style: css.report }, report),
        ) : null,
      );
    }

    function SidebarIcon() {
      return h('svg', { width: 20, height: 20, viewBox: '0 0 64 64', 'aria-hidden': true },
        h('ellipse', { cx: 26, cy: 18, rx: 15, ry: 6, fill: 'none', stroke: 'currentColor', strokeWidth: 3 }),
        h('path', { d: 'M11 18v20c0 3.4 6.7 6 15 6 2.2 0 4.3-.2 6.2-.6', fill: 'none', stroke: 'currentColor', strokeWidth: 3, strokeLinecap: 'round' }),
        h('path', { d: 'M41 34a11 11 0 1 0 0 22', fill: 'none', stroke: 'currentColor', strokeWidth: 3, strokeLinecap: 'round' }),
        h('path', { d: 'M54 45H41M50 41l5 4-5 4', fill: 'none', stroke: 'currentColor', strokeWidth: 3, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }

    return {
      inject: ['slots', 'sessions', 'remote', 'remote.commands'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'mysqlrecover' }, function Main() {
          return h(Page, { ctx });
        }));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'mysqlrecover', order: 120, label: 'mysql数据恢复',
        }, SidebarIcon));
      },
    };
  },
});
