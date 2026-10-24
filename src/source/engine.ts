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
      name: ruleStr([el], r.name || ".text()", res.url),
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
          `name[${r.name || "(默认.text())"}]→"${(ruleStr([items[0]], r.name || ".text()", res.url) || "✗空").slice(0, 24)}"`,
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
    cover: ensureAbs(ruleStr(nodes, r.coverUrl || "", res.url).split(/\s+/)[0] ?? "", res.url), // 封面取第一个 URL，相对地址补全
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

// 目录分页两种方式：
// ① ruleToc.nextTocUrl 命中"下一页"链接 → 循环抓取（href 空=结束）；
// ② {page} 模板翻页——nextTocUrl（或 tocUrl）含 {page} 占位符时按页码 1,2,3… 展开。
//    适合翻页是加密 AJAX、解析不出链接但分页 URL 有规律的站点（如 /book/51RA9-{page}.html）。
//    tocUrl 规则可用 {{bookUrl}}##正则##替换 把详情页地址改写成模板（如 {{bookUrl}}##\.html$##-{page}.html）。
//    模板页章节按 URL 去重；页面上完全没有章节元素即结束；连续 2 页全是重复章节也结束（防站点对任意页码返回同一页）。
//    若 ruleBookInfo.lastChapter 取到的是链接（规则用 .attr('href')），可传入 lastChapterUrl：
//    引擎把最新章节地址套回模板反推最大页码，精确抓 1..max，不再盲试 404（建议如此配置）。
const TOC_MAX_PAGES = 200;
const hasPageTpl = (s: string) => /\{\{?page\}?\}/.test(s);
const expandPage = (t: string, n: number) => t.replace(/\{\{?page\}?\}/g, String(n));

// 由最新章节 URL 反推 {page} 模板的最大页码：模板去掉 origin 后整体转正则，{page} 捕获为数字。
// 匹配不上（latestChapter 是文本、或 URL 形态不同）返回 0 = 未知，退回盲试展开
function maxPageFromTpl(tpl: string, lastChapterUrl?: string): number {
  if (!lastChapterUrl) return 0;
  const origin = tpl.match(/^https?:\/\/[^/]+/i)?.[0] ?? "";
  const relTpl = tpl.slice(origin.length);
  const re = new RegExp(`^${relTpl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{page\\\}/g, "(\\d+)")}$`);
  const cands = [lastChapterUrl, origin && lastChapterUrl.startsWith(origin) ? lastChapterUrl.slice(origin.length) : ""];
  for (const c of cands) {
    const m = c.match(re);
    if (m) return Math.max(0, parseInt(m[1], 10) || 0);
  }
  return 0;
}

export async function getToc(src: BookSource, tocUrl: string, log?: Log, lastChapterUrl?: string): Promise<ChapterItem[]> {
  const r = src.ruleToc ?? {};
  const chapters: ChapterItem[] = [];
  const seenUrls = new Set<string>();
  const visited = new Set<string>();
  const tpl = r.nextTocUrl && hasPageTpl(String(r.nextTocUrl)) ? String(r.nextTocUrl) : hasPageTpl(tocUrl) ? tocUrl : null;
  let tplPage = hasPageTpl(tocUrl) ? 1 : 0; // 模板已展开到的页码
  let current: string | null = hasPageTpl(tocUrl) ? expandPage(tocUrl, 1) : tocUrl;
  const maxPage = tpl ? maxPageFromTpl(tpl, lastChapterUrl) : 0;
  if (maxPage) log?.("info", "toc", `最新章节链接推算目录共 ${maxPage} 页，精确抓取 1..${maxPage}`);
  let noNewStreak = 0;
  let page = 0;

  while (current && page < TOC_MAX_PAGES) {
    const reqUrl = current;
    if (visited.has(reqUrl)) {
      log?.("warn", "toc", `第 ${page + 1} 页地址已抓过（${reqUrl}），停止翻页`);
      break;
    }
    visited.add(reqUrl);
    page++;
    const { url, opts } = buildReq(src, reqUrl);
    log?.("info", "toc", page === 1 ? `目录: ${url}` : `目录第 ${page} 页: ${url}`);
    let res = await httpText(url, opts);
    // 模板模式中间页偶发 4xx（WAF/限流）：重试两次再放弃，好过丢整页章节
    for (let retry = 0; tpl && page > 1 && res.status >= 400 && retry < 2; retry++) {
      await sleep(1000 * (retry + 1));
      log?.("warn", "toc", `第 ${page} 页 HTTP ${res.status}，重试 ${retry + 1}/2`);
      res = await httpText(url, opts);
    }
    if (res.status >= 400) {
      // 模板模式下中间页失败不致命：已知最大页则跳过该页继续，否则返回已抓到的部分
      if (tpl && page > 1) {
        if (maxPage) {
          log?.("warn", "toc", `第 ${page} 页 HTTP ${res.status}，跳过该页继续`);
          tplPage++;
          current = expandPage(tpl, tplPage);
          continue;
        }
        log?.("warn", "toc", `第 ${page} 页 HTTP ${res.status}，返回已抓取的 ${chapters.length} 章`);
        break;
      }
      throw new Error(`HTTP ${res.status} · ${res.charset}`);
    }
    const nodes = guessNodes(res.text);
    const items = ruleList(nodes, r.chapterList ?? "", res.url);
    const got = items
      .map((el) => ({
        title: ruleStr([el], r.chapterName || ".text()", res.url),
        url: ruleStr([el], r.chapterUrl || ".attr('href')", res.url),
      }))
      .filter((c) => c.title && c.url)
      .map((c) => ({ ...c, url: ensureAbs(c.url, res.url) }));
    // 章节按 URL 去重：分页重叠/详情页与目录页第一章重复都不会重复入库
    const fresh = got.filter((c) => !seenUrls.has(c.url));
    fresh.forEach((c) => seenUrls.add(c.url));
    chapters.push(...fresh);
    if (page === 1 && !got.length && items.length && !tpl && log)
      log?.(
        "warn",
        "toc",
        `chapterList 命中 ${items.length} 个元素但章节数为 0（chapterName/chapterUrl 为空即丢弃）。首元素提取: ` +
          `chapterName[${r.chapterName || "(默认.text())"}]→"${(ruleStr([items[0]], r.chapterName || ".text()", res.url) || "✗空").slice(0, 24)}" · ` +
          `chapterUrl[${r.chapterUrl || "(默认.attr('href'))"}]→"${(ruleStr([items[0]], r.chapterUrl || ".attr('href')", res.url) || "✗空").slice(0, 40)}"`,
      );

    // 决定下一页
    if (tpl) {
      if (maxPage) {
        // 最大页码已知（由最新章节链接推算）：中间页偶发空/重复不中断，抓满 1..max 为止
        if (tplPage >= maxPage) {
          log?.("ok", "toc", `已抓到第 ${maxPage} 页（最大页码），目录翻页结束`);
          break;
        }
      } else {
        if (!items.length) {
          log?.("info", "toc", `第 ${page} 页无章节列表，目录翻页结束`);
          break;
        }
        noNewStreak = fresh.length === 0 ? noNewStreak + 1 : 0;
        if (noNewStreak >= 2) {
          log?.("warn", "toc", `连续 ${noNewStreak} 页没有新章节（可能已到末页或站点对任意页码返回相同内容），停止`);
          break;
        }
      }
      tplPage++;
      current = expandPage(tpl, tplPage);
    } else {
      // href 翻页：取下一页链接，为空即结束
      current = null;
      if (r.nextTocUrl) {
        const nRaw = ruleStr(nodes, r.nextTocUrl, res.url)
          .split(/\s+/)
          .filter(Boolean)
          .map((u) => ensureAbs(u, res.url));
        if (nRaw.length > 1) log?.("warn", "toc", `nextTocUrl 命中 ${nRaw.length} 个链接，已取最后一个`);
        const n = nRaw[nRaw.length - 1] ?? "";
        current = n && !visited.has(n) ? n : null;
        if (page === 1 && !current) log?.("info", "toc", `翻页规则未命中下一页链接（仅单页，或规则没匹配上）`);
      }
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getContent(src: BookSource, chapterUrl: string, log?: Log): Promise<string> {
  const { url, opts } = buildReq(src, chapterUrl);
  log?.("info", "content", `正文: ${url}`);
  // 站点偶发 4xx/5xx（反爬/限流）重试兜底：1s → 2s → 4s
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await fetchChapter(src, url, opts, log);
    } catch (e) {
      lastErr = e;
      if (i < 2) await sleep(1000 * 2 ** i);
    }
  }
  throw lastErr;
}

// 抓单章并合并全部分页：ruleContent.nextContentUrl 命中即抓下一页拼接；href 空=结束；visited 防环，上限 50 页。
// 首页失败 → 抛错走重试；第 2 页起失败 → 记 warn 返回已抓到的部分（好过整章失败）。
async function fetchChapter(src: BookSource, url: string, opts: FetchOpts, log?: Log): Promise<string> {
  const rule = src.ruleContent ?? {};
  const visited = new Set<string>();
  const parts: string[] = [];
  let next: string | null = url;
  let page = 0;

  while (next && page < 50) {
    if (visited.has(next)) {
      log?.("warn", "content", `第 ${page + 1} 页地址已抓过，停止翻页`);
      break;
    }
    visited.add(next);
    page++;
    const res = await httpText(next, opts);
    if (res.status >= 400) {
      if (page > 1) {
        log?.("warn", "content", `第 ${page} 页 HTTP ${res.status}，返回已抓取的 ${page - 1} 页`);
        break;
      }
      throw new Error(`HTTP ${res.status} · ${res.charset}`);
    }
    const nodes = guessNodes(res.text);
    const content = ruleStr(nodes, rule.content ?? "", res.url);
    if (!content) {
      if (page > 1) {
        log?.("warn", "content", `第 ${page} 页正文规则未命中，返回已抓取的 ${page - 1} 页`);
        break;
      }
      throw new Error("正文规则未命中");
    }
    parts.push(applyReplace(content, rule.replaceRegex));

    next = null;
    if (rule.nextContentUrl) {
      const nRaw = ruleStr(nodes, rule.nextContentUrl, res.url)
        .split(/\s+/)
        .filter(Boolean)
        .map((u) => ensureAbs(u, res.url));
      if (nRaw.length > 1) log?.("warn", "content", `nextContentUrl 命中 ${nRaw.length} 个链接，已取最后一个`);
      const n = nRaw[nRaw.length - 1] ?? "";
      next = n && !visited.has(n) ? n : null;
      if (next) {
        log?.("info", "content", `正文第 ${page + 1} 页: ${next}`);
        await sleep(250);
      }
    }
  }
  if (page > 1) log?.("ok", "content", `分页合并完成：${page} 页`);

  // 部分站点正文里带字面量 \n / \r\n，统一还原成真实换行
  const merged = parts
    .join("\n")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const ph = isPlaceholder(merged);
  log?.("ok", "content", `正文 ${merged.length} 字${ph ? " · ⚠️疑似占位内容" : ""}`);
  if (log) log("info", "content", `预览: ${merged.slice(0, 80)}…`);
  return merged;
}
