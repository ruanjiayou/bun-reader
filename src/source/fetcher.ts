import * as iconv from "iconv-lite";

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

export async function httpText(url: string, opts: FetchOpts = {}, timeoutMs = 10000): Promise<TextRes> {
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
