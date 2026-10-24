import { httpText, type FetchOpts } from "./fetcher";
import { guessNodes, ruleList, ruleStr } from "./rule";

export type BookSource = Record<string, any>;
export type LogLevel = "info" | "ok" | "warn" | "err";
export type Log = (level: LogLevel, step: string, msg: string) => void;

export interface BookItem {
  name: string;
  author: string;
  bookUrl: string;
  cover: string;
  intro: string;
  latestChapter: string;
}

export interface ChapterItem {
  title: string;
  url: string;
}

const abs = (u: string, base: string) => {
  try {
    return new URL(u, base).toString();
  } catch {
    return u;
  }
};

const ensureAbs = (u: string, base: string) => (u && !/^https?:/i.test(u) ? abs(u, base) : u);

function parseHeader(h: any): Record<string, string> {
  if (!h) return {};
  if (typeof h === "object") return h;
  try {
    return JSON.parse(h);
  } catch {
    return {};
  }
}

// "url,{json选项}" 模板：{{key}}/{{page}} 替换，options 支持 method/body/charset/headers
function buildReq(src: BookSource, path: string, vars: Record<string, string> = {}) {
  let raw = path.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "").trim();
  const opts: FetchOpts = {};
  const i = raw.indexOf(",{");
  if (i > -1) {
    try {
      const o = JSON.parse(raw.slice(i + 1));
      opts.method = o.method;
      opts.body = o.body;
      opts.charset = o.charset;
      opts.headers = parseHeader(o.headers);
      raw = raw.slice(0, i);
    } catch {
      /* 无选项 */
    }
  }
  opts.headers = { ...parseHeader(src.header), ...opts.headers };
  return { url: ensureAbs(raw, src.bookSourceUrl), opts };
}

export async function searchSource(src: BookSource, key: string, log?: Log): Promise<BookItem[]> {
  const { url, opts } = buildReq(src, String(src.searchUrl ?? ""), { key: encodeURIComponent(key), page: "1" });
  if (!url) throw new Error("书源缺少 searchUrl");
  log?.("info", "search", `${opts.method ?? "GET"} ${url}`);
  const res = await httpText(url, opts);
  if (res.status >= 400) throw new Error(`HTTP ${res.status} · ${res.charset}`);
  log?.("info", "search", `响应 ${res.status} · ${res.charset} · ${res.text.length} 字`);
  const nodes = guessNodes(res.text);
  const r = src.ruleSearch ?? {};
  if (!r.bookList) throw new Error("书源缺少 ruleSearch.bookList");
  const items = ruleList(nodes, r.bookList ?? "", res.url);
  log?.(items.length ? "ok" : "warn", "search", `bookList 命中 ${items.length} 条`);
  const books = items
    .map((el) => ({
      name: ruleStr([el], r.name || "text", res.url),
      author: ruleStr([el], r.author || "", res.url),
      bookUrl: ruleStr([el], r.bookUrl || "", res.url),
      cover: ruleStr([el], r.coverUrl || "", res.url).split(/\s+/)[0] ?? "", // 封面取第一个 URL
      intro: ruleStr([el], r.intro || "", res.url),
      latestChapter: ruleStr([el], r.lastChapter || "", res.url),
    }))
    .filter((b) => b.name && b.bookUrl)
    .map((b) => ({ ...b, bookUrl: ensureAbs(b.bookUrl, res.url), cover: ensureAbs(b.cover, res.url) }));
  if (books.length) log?.("ok", "search", `首条: ${books[0].name} · ${books[0].author || "佚名"}`);
  else if (items.length && log)
    log?.(
      "warn",
      "search",
      `命中 ${items.length} 条但全部被过滤（name/bookUrl 为空即丢弃）。首条字段提取: ` +
        [
          `name[${r.name || "(默认text)"}]→"${(ruleStr([items[0]], r.name || "text", res.url) || "✗空").slice(0, 24)}"`,
          `bookUrl[${r.bookUrl || "✗未配置"}]→"${(ruleStr([items[0]], r.bookUrl || "", res.url) || "✗空").slice(0, 40)}"`,
          `author→"${(ruleStr([items[0]], r.author || "", res.url) || "✗空").slice(0, 24)}"`,
        ].join(" · "),
    );
  return books;
}

export async function getBookInfo(src: BookSource, bookUrl: string, log?: Log) {
  const { url, opts } = buildReq(src, bookUrl);
  log?.("info", "book", `详情: ${url}`);
  const res = await httpText(url, opts);
  if (res.status >= 400) throw new Error(`HTTP ${res.status} · ${res.charset}`);
  const nodes = guessNodes(res.text);
  const r = src.ruleBookInfo ?? {};
  const info = {
    name: ruleStr(nodes, r.name || "", res.url),
    author: ruleStr(nodes, r.author || "", res.url),
    intro: ruleStr(nodes, r.intro || "", res.url),
    cover: (ruleStr(nodes, r.coverUrl || "", res.url).split(/\s+/)[0] ?? ""), // 封面取第一个 URL
    latestChapter: ruleStr(nodes, r.lastChapter || "", res.url),
    tocUrl: ruleStr(nodes, r.tocUrl || "", res.url) || bookUrl,
  };
  // tocUrl 规则命中多个时（多行）取最后一个——目录页通常在末尾，且避免多行拼接成垃圾 URL
  const lines = info.tocUrl.split(/\s+/).filter(Boolean);
  if (lines.length > 1) {
    info.tocUrl = lines[lines.length - 1];
    log?.("warn", "book", `tocUrl 规则命中 ${lines.length} 个链接，已取最后一个（要取指定位置请加索引如 a.-1）`);
  }
  info.tocUrl = ensureAbs(info.tocUrl, res.url);
  log?.("ok", "book", `详情解析: ${info.name || "?"} · tocUrl=${info.tocUrl}`);
  return info;
}

// 目录支持分页：ruleToc.nextTocUrl 命中即抓下一页拼接，href 为空=结束；visited 防环，上限 50 页
export async function getToc(src: BookSource, tocUrl: string, log?: Log): Promise<ChapterItem[]> {
  const r = src.ruleToc ?? {};
  const chapters: ChapterItem[] = [];
  const visited = new Set<string>();
  let next: string | null = tocUrl;

  for (let page = 1; next && page <= 50; page++) {
    const { url, opts } = buildReq(src, next);
    if (visited.has(url)) {
      log?.("warn", "toc", `第 ${page} 页地址已抓过（${url}），停止翻页`);
      break;
    }
    visited.add(url);
    log?.("info", "toc", page === 1 ? `目录: ${url}` : `目录第 ${page} 页: ${url}`);
    const res = await httpText(url, opts);
    if (res.status >= 400) throw new Error(`HTTP ${res.status} · ${res.charset}`);
    const nodes = guessNodes(res.text);
    const items = ruleList(nodes, r.chapterList ?? "", res.url);
    const got = items
      .map((el) => ({
        title: ruleStr([el], r.chapterName || "text", res.url),
        url: ruleStr([el], r.chapterUrl || "", res.url),
      }))
      .filter((c) => c.title && c.url)
      .map((c) => ({ ...c, url: ensureAbs(c.url, res.url) }));
    chapters.push(...got);
    if (page === 1 && !got.length && items.length && log)
      log?.(
        "warn",
        "toc",
        `chapterList 命中 ${items.length} 个元素但章节数为 0（chapterName/chapterUrl 为空即丢弃）。首元素提取: ` +
          `chapterName[${r.chapterName || "(默认text)"}]→"${(ruleStr([items[0]], r.chapterName || "text", res.url) || "✗空").slice(0, 24)}" · ` +
          `chapterUrl[${r.chapterUrl || "✗未配置"}]→"${(ruleStr([items[0]], r.chapterUrl || "", res.url) || "✗空").slice(0, 40)}"`,
      );
    // 翻页：取下一页 href，为空即结束
    next = null;
    if (r.nextTocUrl) {
      const nRaw = ruleStr(nodes, r.nextTocUrl, res.url)
        .split(/\s+/)
        .filter(Boolean)
        .map((u) => ensureAbs(u, res.url));
      if (nRaw.length > 1) log?.("warn", "toc", `nextTocUrl 命中 ${nRaw.length} 个链接，已取最后一个`);
      const n = nRaw[nRaw.length - 1] ?? "";
      next = n && !visited.has(n) ? n : null;
      if (page === 1 && !next) log?.("info", "toc", `翻页规则未命中下一页链接（仅单页，或规则没匹配上）`);
    }
  }
  const pages = visited.size;
  log?.(
    chapters.length ? "ok" : "warn",
    "toc",
    `章节 ${chapters.length} 章 · ${pages} 页${pages > 1 ? "（分页）" : ""}${chapters.length ? `，首章: ${chapters[0].title}` : ""}`,
  );
  return chapters;
}

function applyReplace(content: string, rr: any): string {
  if (!rr) return content;
  let rule = "";
  let rep = "";
  if (typeof rr === "object") {
    rule = rr.regex ?? "";
    rep = rr.replacement ?? "";
  } else {
    const parts = String(rr).split("##");
    rule = parts[0];
    rep = parts[1] ?? "";
  }
  if (!rule) return content;
  try {
    return content.replace(new RegExp(rule, "g"), rep);
  } catch {
    return content; // ponytail: 书源正则可能非法，跳过不炸
  }
}

export const PLACEHOLDER_WORDS = [
  "更新中",
  "稍后更新",
  "章节内容稍后",
  "审核中",
  "暂未更新",
  "购买后查看",
  "暂无内容",
  "内容更新中",
];

export function isPlaceholder(content: string, words: string[] = PLACEHOLDER_WORDS, minLen = 50): boolean {
  if (content.length < minLen) return true;
  return words.some((w) => content.includes(w));
}

export async function getContent(src: BookSource, chapterUrl: string, log?: Log): Promise<string> {
  const { url, opts } = buildReq(src, chapterUrl);
  log?.("info", "content", `正文: ${url}`);
  const res = await httpText(url, opts);
  if (res.status >= 400) throw new Error(`HTTP ${res.status} · ${res.charset}`);
  const nodes = guessNodes(res.text);
  let content = ruleStr(nodes, src.ruleContent?.content ?? "", res.url);
  if (!content) throw new Error("正文规则未命中");
  content = applyReplace(content, src.ruleContent?.replaceRegex);
  content = content
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const ph = isPlaceholder(content);
  log?.("ok", "content", `正文 ${content.length} 字${ph ? " · ⚠️疑似占位内容" : ""}`);
  if (log) log("info", "content", `预览: ${content.slice(0, 80)}…`);
  return content;
}
