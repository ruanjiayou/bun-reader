import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fmtLatest } from "../api";

interface BookInfo {
  id: number;
  name: string;
  author: string;
  cover: string;
  intro: string;
  latestChapter: string;
  progress: { chapterIdx: number; scrollPos: number } | null;
}
interface Chapter {
  idx: number;
  title: string;
  cached?: boolean;
}
interface CacheStatus {
  total: number;
  cachedCount: number;
  running: boolean;
  job: { total: number; done: number; failed: number; status: string } | null;
  logs?: { level: "ok" | "warn" | "info"; msg: string; t: number }[];
}

export default function Book() {
  const { id } = useParams();
  const bookId = Number(id);
  const nav = useNavigate();
  const [book, setBook] = useState<BookInfo | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [cur, setCur] = useState<number | null>(null); // 当前进度章节
  const [asc, setAsc] = useState(true);
  const [msg, setMsg] = useState("");
  const [loadErr, setLoadErr] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [cache, setCache] = useState<CacheStatus | null>(null);
  const [caching, setCaching] = useState(false);

  // 操作提示 4s 自动消失
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(""), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  const loadCache = async () => {
    try {
      const s = await api<CacheStatus>(`/api/books/${bookId}/cache-all`);
      setCache(s);
      return s;
    } catch {
      return null;
    }
  };

  const load = async () => {
    try {
      const cat = await api<{ book: BookInfo; chapters: Chapter[]; progress: { chapterIdx: number } | null }>(
        `/api/books/${bookId}/category`,
      );
      setChapters(cat.chapters);
      setCur(cat.progress?.chapterIdx ?? null);
      const info = await api<BookInfo>(`/api/books/${bookId}`);
      setBook({ ...cat.book, ...info, progress: info.progress });
    } catch (e: any) {
      setLoadErr(e.message);
    }
  };
  useEffect(() => {
    load();
    loadCache();
  }, [bookId]);

  // 目录为空时轮询（加书架时目录是后台异步抓的，就绪后自动出现），最长轮询 2 分钟
  useEffect(() => {
    if (chapters.length || loadErr) return;
    let stop = false;
    const t = setInterval(async () => {
      try {
        const cat = await api<{ chapters: Chapter[]; progress: { chapterIdx: number } | null }>(`/api/books/${bookId}/category`);
        if (stop) return;
        if (cat.chapters.length) {
          setChapters(cat.chapters);
          setCur((c) => cat.progress?.chapterIdx ?? c);
        }
      } catch {}
    }, 2000);
    const to = setTimeout(() => (stop = true), 120000);
    return () => {
      stop = true;
      clearInterval(t);
      clearTimeout(to);
    };
  }, [chapters.length, loadErr, bookId]);

  // 缓存任务运行中每 2s 轮询进度
  useEffect(() => {
    if (!cache?.running) return;
    const t = setInterval(async () => {
      const s = await loadCache();
      if (s && !s.running) {
        setMsg(s.job?.failed ? `缓存结束：${s.cachedCount}/${s.total} 章（${s.job.failed} 章失败）` : `缓存完成：${s.cachedCount}/${s.total} 章`);
        await load();
      }
    }, 2000);
    return () => clearInterval(t);
  }, [cache?.running]);

  const cacheAll = async () => {
    setCaching(true);
    try {
      const r = await api<any>(`/api/books/${bookId}/cache-all`, { method: "POST" });
      await loadCache();
      setMsg(r.nothing ? "全部章节已缓存" : r.already ? "缓存任务进行中" : `开始缓存 ${r.queued} 章（后台执行，可关闭页面）`);
    } catch (e: any) {
      setMsg(`缓存失败：${e.message}`);
    } finally {
      setCaching(false);
    }
  };

  const cacheStop = async () => {
    await api(`/api/books/${bookId}/cache-stop`, { method: "POST" });
    setMsg("已停止缓存，已抓取的章节保留");
    await loadCache();
  };

  const cacheRelease = async () => {
    if (!confirm(`释放《${book?.name}》的全部已缓存正文？\n（${cache?.cachedCount ?? 0} 章，释放后阅读时重新抓取；同书所有用户共享此缓存，将一并释放）`)) return;
    const r = await api<{ released: number }>(`/api/books/${bookId}/cache-release`, { method: "POST" });
    setMsg(`已释放 ${r.released} 章缓存`);
    await Promise.all([loadCache(), load()]);
  };

  const refreshToc = async () => {
    setRefreshing(true);
    try {
      const r = await api<{ chapterCount: number; added: number }>(`/api/books/${bookId}/refresh`, { method: "PUT" });
      setMsg(r.added > 0 ? `更新完成：新增 ${r.added} 章，共 ${r.chapterCount} 章` : `已最新，共 ${r.chapterCount} 章`);
      await load();
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setRefreshing(false);
    }
  };

  const remove = async () => {
    if (!confirm(`把《${book?.name}》移出书架？`)) return;
    await api(`/api/books/${bookId}`, { method: "DELETE" });
    nav("/");
  };

  const list = asc ? chapters : [...chapters].reverse();
  const startIdx = cur ?? 0;

  return (
    <div className="mx-auto min-h-dvh max-w-3xl p-4">
      <header className="mb-4 flex items-center gap-2">
        <Link to="/" className="text-sm text-neutral-400 hover:text-neutral-200">← 书架</Link>
      </header>
      {msg && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-neutral-700 px-4 py-2 text-sm text-neutral-100 shadow-lg">
          {msg}
        </div>
      )}

      {/* 缓存条：全本缓存状态 + 操作 */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-neutral-800/60 px-3 py-2 text-xs">
        <span className="text-neutral-400">
          缓存：{cache?.cachedCount ?? 0}/{cache?.total ?? chapters.length} 章
          {cache?.running && cache.job && (
            <span className="ml-1 text-amber-400">
              · 抓取中 {cache.job.done}/{cache.job.total}
              {cache.job.failed ? `（失败 ${cache.job.failed}）` : ""}
            </span>
          )}
        </span>
        <div className="ml-auto flex gap-2">
          {cache?.running ? (
            <button onClick={cacheStop} className="rounded bg-neutral-700 px-2.5 py-1 text-neutral-300 hover:bg-neutral-600">■ 停止缓存</button>
          ) : (
            <button onClick={cacheAll} disabled={caching} className="rounded bg-neutral-700 px-2.5 py-1 text-neutral-300 hover:bg-amber-500 hover:text-neutral-900 disabled:opacity-50">
              {caching ? "启动中…" : "⤓ 缓存全本"}
            </button>
          )}
          <button onClick={cacheRelease} className="rounded bg-neutral-700 px-2.5 py-1 text-neutral-400 hover:bg-red-950 hover:text-red-400">释放缓存</button>
        </div>
      </div>

      {/* 缓存活动日志：最近 30 条（最新在上），成功/失败都显示章节标题 */}
      {cache?.logs && cache.logs.length > 0 && (
        <div className="mb-4 max-h-40 overflow-y-auto rounded-xl bg-neutral-900 p-2 font-mono text-xs leading-5">
          {[...cache.logs].reverse().map((l, i) => (
            <div key={i} className={l.level === "ok" ? "text-emerald-400/80" : l.level === "warn" ? "text-amber-400/80" : "text-neutral-400"}>
              <span className="text-neutral-600">{new Date(l.t).toLocaleTimeString("zh-CN", { hour12: false })}</span> {l.msg}
            </div>
          ))}
        </div>
      )}

      {book && (
        <div className="mb-4 flex gap-4 rounded-xl bg-neutral-800 p-4">
          {book.cover ? (
            <img src={book.cover} alt="" className="h-32 w-24 flex-none rounded-lg object-cover" onError={(e) => (e.currentTarget.style.display = "none")} />
          ) : (
            <div className="flex h-32 w-24 flex-none items-center justify-center rounded-lg bg-neutral-700 text-3xl">📕</div>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-bold">{book.name}</h1>
            <div className="mt-0.5 text-sm text-neutral-400">{book.author || "佚名"}</div>
            {book.latestChapter && <div className="mt-0.5 truncate text-xs text-neutral-500">最新：{fmtLatest(book.latestChapter)}</div>}
            {book.intro && <p className="mt-2 line-clamp-3 text-xs text-neutral-500">{book.intro}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => nav(`/book/${bookId}/read/${startIdx}`)}
                className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-amber-400"
              >
                {cur !== null ? `继续阅读 · ${chapters.find((c) => c.idx === cur)?.title ?? ""}` : "开始阅读"}
              </button>
              <button
                onClick={refreshToc}
                disabled={refreshing}
                className="rounded-lg bg-neutral-800 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-700 disabled:opacity-50"
              >
                {refreshing ? "检查更新中…" : "↻ 检查更新"}
              </button>
              <button
                onClick={remove}
                className="rounded-lg bg-neutral-800 px-3 py-2 text-sm text-red-400 hover:bg-red-950"
              >
                移出书架
              </button>
            </div>
          </div>
        </div>
      )}

      <section id="toc">
        <div className="mb-2 flex items-center">
          <h2 className="text-sm font-bold text-neutral-300">目录</h2>
          <span className="ml-2 text-xs text-neutral-500">共 {chapters.length} 章</span>
          <button onClick={() => setAsc((v) => !v)} className="ml-auto rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-700">
            {asc ? "正序 ↓" : "倒序 ↑"}
          </button>
        </div>
        <div className="divide-y divide-neutral-800 rounded-xl bg-neutral-800/50">
          {list.map((ch) => (
            <Link
              key={ch.idx}
              to={`/book/${bookId}/read/${ch.idx}`}
              className={`block truncate px-4 py-2.5 text-sm hover:bg-neutral-800 ${ch.idx === cur ? "text-amber-400" : "text-neutral-300"}`}
            >
              {ch.title}
              {ch.cached && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 align-middle" title="已缓存" />}
              {ch.idx === cur && <span className="ml-2 text-xs text-neutral-500">· 上次读到</span>}
            </Link>
          ))}
          {!chapters.length && !loadErr && <div className="p-6 text-center text-neutral-600">目录抓取中…（后台生成，就绪后自动显示）</div>}
        </div>
      </section>
    </div>
  );
}
