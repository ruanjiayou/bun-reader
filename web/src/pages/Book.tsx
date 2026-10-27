import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fmtLatest } from "../api";

const PAGE_SIZE = 100; // 目录分页：一页 100 章（几千章的目录一次渲染太重）

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
}

export default function Book() {
  const { id } = useParams();
  const bookId = Number(id);
  const nav = useNavigate();
  const [book, setBook] = useState<BookInfo | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [cur, setCur] = useState<number | null>(null); // 当前进度章节
  const [asc, setAsc] = useState(true);
  const [loading, setLoading] = useState(true); // 目录加载中（区别于「抓取中」的空目录）
  const [page, setPage] = useState(1); // 目录页码（1 起）
  const [msg, setMsg] = useState("");
  const [loadErr, setLoadErr] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [cache, setCache] = useState<CacheStatus | null>(null);
  const [caching, setCaching] = useState(false);
  const pageInit = useRef(0); // 每本书首次拿到目录时，定位到「上次读到」所在页

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
    } finally {
      setLoading(false);
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

  // 首次拿到目录：把页码定位到「上次读到」的章节所在页
  useEffect(() => {
    if (pageInit.current === bookId || !chapters.length) return;
    pageInit.current = bookId;
    setPage(cur != null ? Math.floor(cur / PAGE_SIZE) + 1 : 1);
  }, [chapters.length, bookId, cur]);

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
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const pageClamped = Math.min(page, totalPages);
  const pageItems = list.slice((pageClamped - 1) * PAGE_SIZE, pageClamped * PAGE_SIZE);
  const startIdx = cur ?? 0;

  return (
    <div className="mx-auto min-h-dvh max-w-3xl p-4">
      <header className="mb-4 flex items-center gap-2">
        <Link to="/" className="text-sm text-neutral-400 hover:text-neutral-200">← 书架</Link>
        {/* 缓存信息 + 缓存操作：右上角一排（检查更新移到卡片下方按钮排） */}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2 text-xs">
          <span className="text-neutral-400">
            缓存：{cache?.cachedCount ?? 0}/{cache?.total ?? chapters.length} 章
            {cache?.running && cache.job && (
              <span className="ml-1 text-amber-400">
                · 抓取中 {cache.job.done}/{cache.job.total}
                {cache.job.failed ? `（失败 ${cache.job.failed}）` : ""}
              </span>
            )}
          </span>
          {cache?.running ? (
            <button onClick={cacheStop} className="rounded bg-neutral-700 px-2.5 py-1 text-neutral-300 hover:bg-neutral-600">■ 停止缓存</button>
          ) : (
            <button onClick={cacheAll} disabled={caching} className="rounded bg-neutral-700 px-2.5 py-1 text-neutral-300 hover:bg-amber-500 hover:text-neutral-900 disabled:opacity-50">
              {caching ? "启动中…" : "⤓ 缓存全本"}
            </button>
          )}
          <button onClick={cacheRelease} className="rounded bg-neutral-700 px-2.5 py-1 text-neutral-400 hover:bg-red-950 hover:text-red-400">释放缓存</button>
        </div>
      </header>
      {msg && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-neutral-700 px-4 py-2 text-sm text-neutral-100 shadow-lg">
          {msg}
        </div>
      )}

      {book && (
        <div className="mb-3 rounded-xl bg-neutral-800 p-4">
          {/* 封面在左（垂直居中），标题/作者/简介/进度都在右侧；操作按钮统一放卡片下方一排 */}
          <div className="flex items-center gap-4">
            {book.cover ? (
              <img src={book.cover} alt="" className="h-36 w-27 flex-none rounded-lg object-cover" onError={(e) => (e.currentTarget.style.display = "none")} />
            ) : (
              <div className="flex h-36 w-27 flex-none items-center justify-center rounded-lg bg-neutral-700 text-3xl">📕</div>
            )}
            <div className="min-w-0 flex-1">
              <h1 className="text-lg font-bold">{book.name}</h1>
              <div className="mt-0.5 truncate text-sm text-neutral-400">{book.author || "佚名"}</div>
              {book.intro && <p className="mt-2 line-clamp-3 text-xs text-neutral-500">{book.intro}</p>}
              {/* 简介下方：最新章节 / 读到章节 各占一行 */}
              {book.latestChapter && <div className="mt-2 truncate text-xs text-neutral-500">最新章节：{fmtLatest(book.latestChapter)}</div>}
              <div className="mt-1 truncate text-xs text-neutral-400">
                {cur !== null ? (
                  <>
                    <span className="text-neutral-500">读到：</span>
                    {chapters.find((c) => c.idx === cur)?.title ?? ""}
                    <span className="text-neutral-600">
                      （{cur + 1}/{chapters.length}）
                    </span>
                  </>
                ) : (
                  <span className="text-neutral-500">尚未开始阅读</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 操作按钮一排（卡片下方）：阅读 / 移出书架 / 检查更新 */}
      {book && (
        <div className="mb-4 flex gap-2">
          <button
            onClick={() => nav(`/book/${bookId}/read/${startIdx}`)}
            className="flex-1 rounded-lg bg-amber-500 py-2 text-sm font-medium text-neutral-900 hover:bg-amber-400"
          >
            {cur !== null ? "继续阅读" : "开始阅读"}
          </button>
          <button onClick={remove} className="rounded-lg bg-neutral-700 px-4 py-2 text-sm text-red-400 hover:bg-red-950">移出书架</button>
          <button
            onClick={refreshToc}
            disabled={refreshing}
            className="rounded-lg bg-neutral-700 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-600 disabled:opacity-50"
          >
            {refreshing ? "检查中…" : "检查更新"}
          </button>
        </div>
      )}

      <section id="toc">
        <div className="mb-2 flex items-center">
          <h2 className="text-sm font-bold text-neutral-300">目录</h2>
          <span className="ml-2 text-xs text-neutral-500">共 {chapters.length} 章</span>
          <button
            onClick={() => {
              setAsc((v) => !v);
              setPage(1);
            }}
            className="ml-auto rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-700"
          >
            {asc ? "正序 ↓" : "倒序 ↑"}
          </button>
        </div>

        {loading ? (
          // 目录请求中：明确显示加载态，不与「空目录/抓取中」混淆
          <div className="flex h-40 items-center justify-center rounded-xl bg-neutral-800/50 text-sm text-neutral-500">
            <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-neutral-600 border-t-amber-500" />
            目录加载中…
          </div>
        ) : (
          <div className="divide-y divide-neutral-800 rounded-xl bg-neutral-800/50">
            {pageItems.map((ch) => (
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
            {loadErr && !chapters.length && <div className="p-6 text-center text-neutral-600">{loadErr}</div>}
          </div>
        )}

        {/* 分页：一页 100 章，几千章的目录不再整页渲染 */}
        {!loading && totalPages > 1 && (
          <div className="mt-2 flex items-center justify-center gap-3 text-xs text-neutral-400">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={pageClamped <= 1}
              className="rounded bg-neutral-800 px-3 py-1 hover:bg-neutral-700 disabled:opacity-40"
            >
              上一页
            </button>
            <span>
              第 {pageClamped} / {totalPages} 页
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={pageClamped >= totalPages}
              className="rounded bg-neutral-800 px-3 py-1 hover:bg-neutral-700 disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
