import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.join(here, 'mysqlrecover_helper.py');
const python = process.env.DSH_MYSQLRECOVER_PYTHON || 'python';
const progressJobs = new Map();

async function openDirectory(targetPath) {
  const raw = String(targetPath || '').trim();
  if (!raw) throw new Error('文件路径为空');
  const resolved = path.resolve(raw);
  const stat = await fs.stat(resolved);
  const directory = stat.isDirectory() ? resolved : path.dirname(resolved);
  // Prefer DSH's native desktop opener (uses Explorer/Finder/xdg-open with
  // proper visible-window semantics). It is a shipped package, but a locally
  // installed plugin may not resolve it; fall back to a direct launcher.
  try {
    const native = await import('@deepseek-ai/dsh-native-command');
    if (typeof native.canOpenNativePath === 'function' && native.canOpenNativePath()) {
      await native.revealNativePath(resolved, undefined);
      return directory;
    }
  } catch {
    /* fall through to the platform launcher */
  }
  const child = process.platform === 'win32'
    ? spawn(process.env.SystemRoot ? `${process.env.SystemRoot}\\explorer.exe` : 'explorer.exe',
      [`/select,${resolved}`], { detached: true, stdio: 'ignore', windowsHide: false })
    : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [directory], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref?.();
  return directory;
}

function runHelper(payload, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [helperPath], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(stdout.trim());
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 4 * 1024 * 1024) {
        child.kill();
        finish(new Error('mysqlrecover 输出超过 4MB，请降低 preview_rows 或缩小时间范围'));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 256 * 1024) stderr = stderr.slice(-256 * 1024);
    });
    child.on('error', (error) => {
      const hint = error && error.code === 'ENOENT'
        ? `找不到 Python 可执行文件 ${python}；请安装 Python 3 并确保在 PATH 中，或设置 DSH_MYSQLRECOVER_PYTHON。`
        : String(error);
      finish(new Error(hint));
    });
    child.on('close', (code) => {
      if (settled) return;
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || `mysqlrecover helper exited with code ${code}`));
    });
    if (signal) {
      if (signal.aborted) {
        child.kill();
        finish(new Error('mysqlrecover call aborted'));
        return;
      }
      signal.addEventListener('abort', () => {
        child.kill();
        finish(new Error('mysqlrecover call aborted'));
      }, { once: true });
    }
    child.stdin.end(JSON.stringify(payload));
  });
}

export const inject = ['commands'];

export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    const dispose = webCtx.webServer.register({
      kind: 'prefix',
      path: '/mysqlrecover/progress',
      resource: async (request) => {
        const job = new URL(request.url).searchParams.get('job') || '';
        const file = progressJobs.get(job);
        const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
        if (!file) {
          return new Response(JSON.stringify({ scanned: 0, records: 0, done: false, error: 'unknown job' }), { headers });
        }
        try {
          return new Response(await fs.readFile(file, 'utf8'), { headers });
        } catch {
          return new Response(JSON.stringify({ scanned: 0, records: 0, done: false, error: '' }), { headers });
        }
      },
    });
    webCtx.effect(() => dispose);
  });

  const tool = {
    name: 'mysqlrecover',
    description: 'Generate a MySQL binlog rollback SQL file without executing it. '
      + 'Supports time-window recovery and target-SQL recovery, table size reporting, small-table backup SQL, '
      + 'and SQL to create/drop a temporary recovery user. '
      + 'Required MySQL privileges: SELECT on the target database/table, REPLICATION CLIENT, REPLICATION SLAVE. '
      + 'SECURITY: the password is a tool argument and therefore enters the model context and session log; use only a temporary account and rotate any production password exposed here. '
      + 'The tool only generates SQL; the user must review and execute it. '
      + 'It never creates or drops a user and never executes rollback SQL.',
    parameters: {
      host: { type: 'string', required: true, description: 'MySQL host/IP.' },
      port: { type: 'integer', description: 'MySQL port, default 3306.' },
      database: { type: 'string', required: true, description: 'Database name.' },
      table: { type: 'string', required: true, description: 'Table name.' },
      user: { type: 'string', required: true, description: 'Recovery account user. Prefer a temporary account.' },
      password: { type: 'string', required: true, description: 'Recovery account password. Passed to the helper via stdin and not echoed.' },
      mode: {
        type: 'string', required: true, enum: ['time', 'sql'],
        description: 'time: recover all DML in the time window; sql: match rows affected by target_sql within the time window.',
      },
      start_time: { type: 'string', description: 'Start time, YYYY-MM-DD HH:MM:SS (server local time). Required for both modes.' },
      end_time: { type: 'string', description: 'End time, YYYY-MM-DD HH:MM:SS (server local time). Required for both modes.' },
      target_sql: { type: 'string', description: 'The mistaken UPDATE/DELETE/INSERT SQL. Required when mode=sql; simple AND equality/IN/LIKE conditions are supported.' },
      temp_user: { type: 'boolean', description: 'Generate SQL for a temporary recovery user and its DROP statement (default true). Nothing is executed.' },
      temp_user_name: { type: 'string', description: 'Optional temporary user name; random if omitted. When temp_user=false, pass a previous name to get only its DROP USER SQL.' },
      temp_password: { type: 'string', description: 'Optional temporary user password; random if omitted.' },
      preview_rows: { type: 'integer', description: 'SQL preview lines returned in chat, default 80, max 500. Full SQL is written to the file.' },
      max_rows: { type: 'integer', description: 'Maximum generated rollback rows, default 20000, max 200000. Larger scans should use a narrower window.' },
      output_dir: { type: 'string', description: 'Directory for the .sql file; defaults to the OS temp directory/mysqlrecover.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    timeoutMs: 600000,
    async execute(args, exec) {
      const payload = {
        host: args.host,
        port: args.port ?? 3306,
        database: args.database,
        table: args.table,
        user: args.user,
        password: args.password,
        mode: args.mode,
        start_time: args.start_time,
        end_time: args.end_time,
        target_sql: args.target_sql,
        temp_user: args.temp_user ?? true,
        temp_user_name: args.temp_user_name,
        temp_password: args.temp_password,
        preview_rows: args.preview_rows ?? 80,
        max_rows: args.max_rows ?? 20000,
        output_dir: args.output_dir,
      };
      return runHelper(payload, exec.signal);
    },
  };
  // The workspace page sends the password through this user-only command instead
  // of a model tool call. recordInput:false keeps the command arguments
  // (including the password) out of the session log; the result contains only
  // SQL previews and file paths, never the database password.
  ctx.effect(() => ctx.commands.register({
    name: 'mysqlrecover-ui',
    description: 'Internal transport for the MySQL data recovery page; not a model command.',
    recordInput: false,
    handler: async ({ rawInput, signal }) => {
      let progressFile = '';
      try {
        const payload = JSON.parse(String(rawInput || '').trim());
        if (payload.action === 'open_dir') {
          const directory = await openDirectory(payload.path);
          return { kind: 'success', text: `已打开目录：${directory}` };
        }
        if (payload.action === 'recover' && payload.job_id) {
          const jobId = String(payload.job_id).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80);
          progressFile = path.join(os.tmpdir(), `mysqlrecover-progress-${jobId}.json`);
          progressJobs.set(jobId, progressFile);
          payload.progress_file = progressFile;
          setTimeout(() => progressJobs.delete(jobId), 10 * 60 * 1000).unref?.();
        }
        const text = await runHelper(payload, signal);
        return { kind: 'success', text };
      } catch (error) {
        if (progressFile) {
          try {
            await fs.writeFile(progressFile, JSON.stringify({ scanned: 0, records: 0, done: true, error: String(error && error.message ? error.message : error) }), 'utf8');
          } catch {
            /* best effort */
          }
        }
        return { kind: 'error', text: String(error && error.message ? error.message : error) };
      }
    },
  }));
}
