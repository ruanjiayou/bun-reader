import * as iconv from "iconv-lite";
import { log } from "../log";

export interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  charset?: string;
}

export interface TextRes {
  text: string;
  url: string; // 最终 URL（跟随重定向后），作为规则里的 base
  status: number;
  charset: string;
}

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
};

async function raw(url: string, opts: FetchOpts, timeoutMs: number): Promise<TextRes> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: { ...DEFAULT_HEADERS, ...opts.headers },
      body: opts.body,
      redirect: "follow",
      signal: ctl.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    // 编码判定顺序：书源声明 > 响应头 > HTML meta > UTF-8
    let charset = opts.charset?.toLowerCase() ?? "";
    if (!charset) {
      const m = (res.headers.get("content-type") ?? "").match(/charset=([\w-]+)/i);
      if (m) charset = m[1].toLowerCase();
    }
    if (!charset) {
      const head = buf.subarray(0, 2048).toString("latin1");
      const m = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
      if (m) charset = m[1].toLowerCase();
    }
    if (!charset || charset === "utf8") charset = "utf-8";
    return { text: iconv.decode(buf, charset), url: res.url || url, status: res.status, charset };
  } finally {
    clearTimeout(timer);
  }
}

// 站点换域名（sudugu.org → suduguu.com 这类）时，301 的 Location 常是「绝对路径且不带查询串」，
// 跟随重定向会把 ?key= 弄丢，落到新域名的空参数页上——搜索页因此 500、目录/详情却正常（它们靠路径不靠参数）。
// 兜底：跨域名跳转 + 最终 URL 丢了查询串 + 拿到 4xx/5xx 时，用「最终域名+原查询串」再请求一次。
function retryUrlAfterLostQuery(from: string, finalUrl: string): string | null {
  const qi = from.indexOf("?");
  if (qi < 0) return null;
  try {
    const a = new URL(from);
    const b = new URL(finalUrl);
    if (a.host === b.host) return null; // 同域名重定向多为规范化，不猜
    if (b.search) return null; // 最终 URL 自带参数，不是丢参
    return `${b.origin}${b.pathname}${from.slice(qi)}`;
  } catch {
    return null;
  }
}

export async function httpText(url: string, opts: FetchOpts = {}, timeoutMs = 10000): Promise<TextRes> {
  const first = await raw(url, opts, timeoutMs);
  if (first.status < 400) return first;
  const isGet = (opts.method ?? "GET").toUpperCase() === "GET" && !opts.body;
  if (!isGet) return first;
  const retry = retryUrlAfterLostQuery(url, first.url);
  if (!retry) return first;
  const second = await raw(retry, opts, timeoutMs);
  if (second.status >= first.status) return first; // 兜底没救回来，返回原始错误更真实
  log.warn("fetch", `重定向丢失查询串，用 ${retry} 重试 → ${second.status}`);
  return second;
}
