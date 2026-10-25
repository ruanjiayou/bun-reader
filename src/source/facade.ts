import { getBookInfo, getContent, getToc, searchSource, type BookItem, type ChapterItem, type Log } from "./engine";
import { normalizeSource } from "./rule";
import { scriptBookInfo, scriptContent, scriptSearch, scriptToc } from "./script";

// —— 书源引擎门面 ——
// 按 sources.type 分流：rules → 规则引擎（存量/导入源），script → class 脚本引擎。
// 上层（books/sources 路由）只面向 Engine 接口，不感知引擎类型。

export interface BookInfoResult {
  name: string;
  author: string;
  intro: string;
  cover: string;
  latestChapter: string;
  latestChapterUrl: string;
  tocUrl: string;
}

export interface Engine {
  sourceName: string;
  hasSearch: boolean;
  search(key: string, log?: Log): Promise<BookItem[]>;
  bookInfo(url: string, log?: Log): Promise<BookInfoResult>;
  toc(url: string, log?: Log, lastChapterUrl?: string): Promise<ChapterItem[]>;
  content(url: string, log?: Log): Promise<string>;
}

export function rulesEngine(json: string): Engine {
  const src = normalizeSource(JSON.parse(json));
  return {
    sourceName: String(src.bookSourceName ?? ""),
    hasSearch: !!src.searchUrl,
    search: (key, log) => searchSource(src, key, log),
    bookInfo: (url, log) => getBookInfo(src, url, log),
    toc: (url, log, lastChapterUrl) => getToc(src, url, log, lastChapterUrl),
    content: (url, log) => getContent(src, url, log),
  };
}

export function scriptEngine(row: { id: number; name?: string }): Engine {
  return {
    sourceName: row.name ?? `源#${row.id}`,
    hasSearch: true, // 实际有没有 search 方法由 scriptSearch 判定（缺方法返回空列表）
    search: (key, log) => scriptSearch(row, key, log),
    bookInfo: (url, log) => scriptBookInfo(row, url, log),
    toc: (url, log) => scriptToc(row, url, log),
    content: (url, log) => scriptContent(row, url, log),
  };
}

export function engineFor(row: { id: number; name: string; type?: string | null; json: string }): Engine {
  return row.type === "script" ? scriptEngine(row) : rulesEngine(row.json);
}
