import { appendFileSync, mkdirSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

// 轻量日志：控制台 + 按天落盘 data/logs/YYYY-MM-DD.log
const LOG_DIR = "data/logs";

// 请求级日志汇集：调试面板的 SSE 流用它把「浏览器启动 / 人机验证等待 / 抓取」等底层日志实时转发到前端。
// 没挂 sink 时（普通请求）只落盘，行为不变。
export type LogLevel2 = "info" | "warn" | "error";
export type LogSink = (level: LogLevel2, tag: string, msg: string) => void;
const sinkAls = new AsyncLocalStorage<LogSink>();

export function runWithLogSink<T>(sink: LogSink, fn: () => T): T {
  return sinkAls.run(sink, fn);
}

function stamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function write(level: LogLevel2, tag: string, msg: string) {
  const line = `[${stamp()}] [${level.toUpperCase()}] [${tag}] ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(`${LOG_DIR}/${today()}.log`, line + "\n");
  } catch {
    /* 日志落盘失败不影响业务 */
  }
  try {
    sinkAls.getStore()?.(level, tag, msg);
  } catch {
    /* sink 内部异常（如 SSE 已关闭）不影响业务 */
  }
}

export const log = {
  info: (tag: string, msg: string) => write("info", tag, msg),
  warn: (tag: string, msg: string) => write("warn", tag, msg),
  error: (tag: string, msg: string) => write("error", tag, msg),
};

// HTTP 访问日志中间件（静态资源不打，只记 /api 和 /auth）
export function requestLogger() {
  return async (c: any, next: () => Promise<void>) => {
    const path = new URL(c.req.url).pathname;
    const start = Date.now();
    await next();
    if (!path.startsWith("/api") && !path.startsWith("/auth")) return;
    const ms = Date.now() - start;
    const line = `${c.req.method} ${path} → ${c.res.status} ${ms}ms`;
    if (c.res.status >= 500) log.error("http", line);
    else if (c.res.status >= 400) log.warn("http", line);
    else log.info("http", line);
  };
}
