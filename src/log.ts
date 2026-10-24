import { appendFileSync, mkdirSync } from "node:fs";

// 轻量日志：控制台 + 按天落盘 data/logs/YYYY-MM-DD.log
const LOG_DIR = "data/logs";

function stamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function write(level: "info" | "warn" | "error", tag: string, msg: string) {
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
