import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fmtLatest } from "../api";
import { useConfirm } from "../Confirm";

const PAGE_SIZE = 100; // 目录分页：一页 100 章（几千章的目录一次渲染太重）

interface BookInfo {
  id: number;
  name: string;
  author: string;
  cover: string;
  intro: string;
  latestChapter: string;
  sourceId?: number | null;
  sourceName?: string; // 由 GET /api/books/:id 联表带出
  onShelf?: boolean; // 是否在我的书架（预览即入库：书在库里不代表已收藏）
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
  const [ask, confirmUi] = useConfirm();
  const [book, setBook] = useState<BookInfo | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [cur, setCur] = useState<number | null>(null); // 当前进度章节
  const [asc, setAsc] = useState(true);
  const [loading, setLoading] = useState(true); // 目录加载中（区别于「抓取中」的空目录）
  const [page, setPage] = useState(1); // 目录页码（1 起）
  const [msg, setMsg] = useState("");
  const [loadErr, setLoadErr] = useState("");
  // 后台目录抓取状态（后端 /category 带回）：fetching 才值得等，failed 立刻停并把原因显示出来
  const [toc, setToc] = useState<{ status: "idle" | "fetching" | "done" | "failed"; error?: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [cache, setCache] = useState<CacheStatus | null>(null);
  const [caching, setCaching] = useState(false);
  const [editing, setEditing] = useState(false); // 编辑书籍元数据弹层
  const [editForm, setEditForm] = useState<{ name: string; author: string; intro: string; latestChapter: string; cover: string }>({
    name: "", author: "", intro: "", latestChapter: "", cover: "",
  });
  const [coverPreview, setCoverPreview] = useState("");
  const [saving, setSaving] = useState(false);
  const pageInit = useRef(0); // 每本书首次拿到目录时，定位到「上次读到」所在页
  const tocRef = useRef<HTMLDivElement>(null); // 目录滚动容器（翻页后回顶）

  // 把所选图片压缩成 dataURL（最长边 360px 的 JPEG）作为封面上传；限 2MB
  const onCoverFile = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 360;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        cv.getContext("2d")!.drawImage(img, 0, 0, w, h);
        const data = cv.toDataURL("image/jpeg", 0.82);
        if (data.length > 2_000_000) { setMsg("封面图片过大，请选更小的图"); return; }
        setEditForm((f) => ({ ...f, cover: data }));
        setCoverPreview(data);
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  const openEdit = () => {
    if (!book) return;
    setEditForm({ name: book.name, author: book.author, intro: book.intro, latestChapter: book.latestChapter, cover: book.cover });
    setCoverPreview(book.cover);
    setEditing(true);
  };
  const saveEdit = async () => {
    setSaving(true);
    try {
      const r = await api<{ changed: number }>(`/api/books/${bookId}`, {
        method: "PATCH",
        body: JSON.stringify(editForm),
      });
      setEditing(false);
      setMsg(r.changed > 0 ? "已保存修改" : "无改动");
      await load();
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setSaving(false);
    }
  };

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
      const cat = await api<{
        book: BookInfo;
        chapters: Chapter[];
        progress: { chapterIdx: number } | null;
        toc?: { status: "idle" | "fetching" | "done" | "failed"; error?: string };
      }>(`/api/books/${bookId}/category`);
      setChapters(cat.chapters);
      setCur(cat.progress?.chapterIdx ?? null);
      if (cat.toc) setToc(cat.toc);
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

  // 目录为空时的等待：只在后端确实「正在抓」时才轮询，且一次请求结束才发下一次。
  // 原来是无条件 setInterval 2s + 无脑跑满 2 分钟：后台早失败了页面还在打请求，
  // 接口一慢还会把请求堆起来（刷新页面又开一轮），表现就是「一直在发请求」。
  // 间隔逐步放宽（1.5s→3s→5s→8s→10s 封顶）：慢站目录要几分钟，用固定 2s 会白打上百次请求。
  useEffect(() => {
    if (chapters.length || loadErr) return;
    if (toc && toc.status !== "fetching") return; // idle / done / failed 都不该再等
    const DELAYS = [1500, 3000, 5000, 8000, 10000];
    let stop = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stop) return;
      try {
        const cat = await api<{
          chapters: Chapter[];
          progress: { chapterIdx: number } | null;
          toc?: { status: "idle" | "fetching" | "done" | "failed"; error?: string };
        }>(`/api/books/${bookId}/category`);
        if (stop) return;
        if (cat.toc) setToc(cat.toc);
        if (cat.chapters.length) {
          setChapters(cat.chapters);
          setCur((c) => cat.progress?.chapterIdx ?? c);
          return; // 目录到了，结束轮询（依赖变化也会把 effect 清掉）
        }
        if (cat.toc?.status === "failed") return; // 后台已失败：立刻停，别继续空转
      } catch {
        // 单次失败不终止：后端可能正好在重启，下一轮再看状态
      }
      const wait = DELAYS[Math.min(attempt++, DELAYS.length - 1)];
      if (!stop) timer = setTimeout(tick, wait);
    };
    timer = setTimeout(tick, DELAYS[0]);
    const to = setTimeout(() => (stop = true), 300000); // 兜底：最长等 5 分钟（站点慢时单页就要 15s+）
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      clearTimeout(to);
    };
  }, [chapters.length, loadErr, bookId, toc?.status]);

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
    const ok = await ask({
      title: `释放《${book?.name}》的全部已缓存正文？`,
      desc: `共 ${cache?.cachedCount ?? 0} 章。释放后再次阅读会重新抓取（受书源限速，可能变慢）；\n同书所有用户共享这份缓存，会一并释放。`,
      okText: "释放",
    });
    if (!ok) return;
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
      // 后端 502 带的是书源侧的真实原因（超时/内容为空/HTTP 4xx），直接摊在这里，别只说"失败"
      setMsg(`目录抓取失败：${e.message}`);
      setToc({ status: "failed", error: e.message });
    } finally {
      setRefreshing(false);
    }
  };

  // 移出书架：只删关联（书与缓存还在，没人收藏时由每日清理回收），页面留在详情不跳走
  const removeFromShelf = async () => {
    const ok = await ask({
      title: `把《${book?.name}》移出书架？`,
      desc: "只移除书架关联，章节与正文缓存保留；之后可在搜索/探索里重新加入。",
      okText: "移出",
    });
    if (!ok) return;
    await api(`/api/books/${bookId}/shelf`, { method: "DELETE" });
    setBook((b) => (b ? { ...b, onShelf: false } : b));
    setMsg("已移出书架");
  };

  const addToShelf = async () => {
    try {
      await api(`/api/books/${bookId}/shelf`, { method: "POST" });
      setBook((b) => (b ? { ...b, onShelf: true } : b));
      setMsg("已加入书架");
      // 目录还空着时后端会顺带再抓一次：拉一遍状态，把「失败/空闲」改回抓取中，轮询才会重新开始
      if (!chapters.length) await load();
    } catch (e: any) {
      setMsg(`加入书架失败：${e.message}`);
    }
  };

  const list = asc ? chapters : [...chapters].reverse();
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const pageClamped = Math.min(page, totalPages);
  const pageItems = list.slice((pageClamped - 1) * PAGE_SIZE, pageClamped * PAGE_SIZE);
  const startIdx = cur ?? 0;

  // 翻页/切排序后目录回到顶部（列表是内部滚动的，不重置会停在上一页的位置）
  useEffect(() => {
    tocRef.current?.scrollTo({ top: 0 });
  }, [pageClamped, asc]);

  return (
    // 整页定高（h-dvh）分三层：头部信息区 flex-none，目录区 min-h-0 flex-1 内部滚动，分页贴底
    <div className="mx-auto flex h-dvh max-w-3xl flex-col overflow-hidden p-4">
      {confirmUi}
      <header className="mb-3 flex flex-none items-center gap-2">
        <Link to="/" className="text-sm text-neutral-400 hover:text-neutral-200">← 书架</Link>
      </header>
      {msg && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-neutral-700 px-4 py-2 text-sm text-neutral-100 shadow-lg">
          {msg}
        </div>
      )}

      {book && (
        <div className="mb-3 flex-none rounded-xl bg-neutral-800 p-4">
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

      {/* 操作按钮一排（卡片下方）：全部左对齐、按内容定宽（阅读钮不再 flex-1 拉满） */}
      {book && (
        <div className="mb-2 flex flex-none flex-wrap items-center gap-2">
          <button
            onClick={() => nav(`/book/${bookId}/read/${startIdx}`)}
            className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-amber-400"
          >
            {cur !== null ? "继续阅读" : "开始阅读"}
          </button>
          {book.onShelf ? (
            <button onClick={removeFromShelf} className="rounded-lg bg-neutral-700 px-4 py-2 text-sm text-red-400 hover:bg-red-950">移出书架</button>
          ) : (
            <button onClick={addToShelf} className="rounded-lg bg-neutral-700 px-4 py-2 text-sm text-amber-400 hover:bg-neutral-600">＋ 加入书架</button>
          )}
          <button
            onClick={refreshToc}
            disabled={refreshing}
            className="rounded-lg bg-neutral-700 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-600 disabled:opacity-50"
          >
            {refreshing ? "检查中…" : "检查更新"}
          </button>
          <button onClick={openEdit} className="rounded-lg bg-neutral-700 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-600">编辑</button>
        </div>
      )}

      {/* 缓存一排（阅读按钮下方）：左侧标出本书所属书源，右侧缓存信息 + 缓存操作。
          justify-between：一行放得下时缓存组靠右，窄屏换行后整体左对齐，不会吊在右边 */}
      {book && (
        <div className="mb-3 flex flex-none flex-wrap items-center justify-between gap-x-3 gap-y-2 text-xs">
          <span className="min-w-0 truncate text-neutral-500">
            书源：
            <span className={book.sourceName ? "text-neutral-300" : "text-amber-500"}>
              {book.sourceName || (book.sourceId != null ? `#${book.sourceId}` : "无（源已删除）")}
            </span>
          </span>
          <div className="flex flex-wrap items-center justify-end gap-2">
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
        </div>
      )}

      {/* 编辑书籍元数据：封面支持 URL 输入 + 上传图片；其余字段可选填 */}
      {book && editing && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60" onClick={() => setEditing(false)}>
          <div className="w-full max-w-lg rounded-t-2xl p-4 pb-8" style={{ background: "#262626", color: "#e5e5e5" }} onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center">
              <h3 className="text-sm font-bold">编辑书籍信息</h3>
              <button onClick={() => setEditing(false)} className="ml-auto px-2 text-lg opacity-60 hover:opacity-100">×</button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs opacity-60">书名</label>
                <input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} className="w-full rounded-lg bg-neutral-700 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs opacity-60">作者</label>
                <input value={editForm.author} onChange={(e) => setEditForm((f) => ({ ...f, author: e.target.value }))} className="w-full rounded-lg bg-neutral-700 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs opacity-60">简介</label>
                <textarea value={editForm.intro} onChange={(e) => setEditForm((f) => ({ ...f, intro: e.target.value }))} rows={3} className="w-full resize-none rounded-lg bg-neutral-700 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs opacity-60">最新章节</label>
                <input value={editForm.latestChapter} onChange={(e) => setEditForm((f) => ({ ...f, latestChapter: e.target.value }))} className="w-full rounded-lg bg-neutral-700 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs opacity-60">封面</label>
                <div className="flex gap-3">
                  {coverPreview ? (
                    <img src={coverPreview} alt="" className="h-24 w-18 flex-none rounded-lg object-cover" />
                  ) : (
                    <div className="flex h-24 w-18 flex-none items-center justify-center rounded-lg bg-neutral-700 text-2xl">📕</div>
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <input
                      value={editForm.cover.startsWith("data:") ? "" : editForm.cover}
                      placeholder="粘贴封面 URL"
                      onChange={(e) => { setEditForm((f) => ({ ...f, cover: e.target.value })); setCoverPreview(e.target.value); }}
                      className="w-full rounded-lg bg-neutral-700 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-500"
                    />
                    <label className="cursor-pointer self-start rounded-lg bg-neutral-600 px-3 py-1.5 text-xs hover:bg-neutral-500">
                      上传图片
                      <input type="file" accept="image/*" className="hidden" onChange={(e) => onCoverFile(e.target.files?.[0])} />
                    </label>
                    {(editForm.cover || coverPreview) && (
                      <button onClick={() => { setEditForm((f) => ({ ...f, cover: "" })); setCoverPreview(""); }} className="self-start text-xs text-red-400 hover:underline">
                        清除封面
                      </button>
                    )}
                  </div>
                </div>
                <p className="mt-1 text-[11px] opacity-40">上传图片会自动压缩；以 data: 开头的封面不会被自动巡检覆盖。</p>
              </div>
            </div>
            <div className="mt-4 flex gap-2">
              <button onClick={saveEdit} disabled={saving} className="flex-1 rounded-lg bg-amber-500 py-2 text-sm font-medium text-neutral-900 hover:bg-amber-400 disabled:opacity-50">
                {saving ? "保存中…" : "保存"}
              </button>
              <button onClick={() => setEditing(false)} className="rounded-lg bg-neutral-700 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-600">取消</button>
            </div>
          </div>
        </div>
      )}

      {/* 目录区：占满剩余高度，列表自身滚动（隐藏滚动条），分页条固定在底部不跟着滚 */}
      <section id="toc" className="flex min-h-0 flex-1 flex-col">
        <div className="mb-2 flex flex-none items-center">
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
          <div className="flex flex-1 items-center justify-center rounded-xl bg-neutral-800/50 text-sm text-neutral-500">
            <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-neutral-600 border-t-amber-500" />
            目录加载中…
          </div>
        ) : (
          <div ref={tocRef} className="no-scrollbar min-h-0 flex-1 divide-y divide-neutral-800 overflow-y-auto rounded-xl bg-neutral-800/50">
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
            {!chapters.length && !loadErr && toc?.status === "failed" && (
              <div className="p-6 text-center">
                <div className="text-sm text-red-400">目录抓取失败</div>
                <div className="mx-auto mt-1 max-w-xl break-words text-xs leading-5 text-neutral-500">{toc.error}</div>
                <button
                  onClick={refreshToc}
                  disabled={refreshing}
                  className="mt-3 rounded bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 disabled:opacity-50"
                >
                  {refreshing ? "重试中…" : "重试抓目录"}
                </button>
              </div>
            )}
            {!chapters.length && !loadErr && toc?.status === "fetching" && (
              <div className="p-6 text-center text-neutral-600">目录抓取中…（后台生成，就绪后自动显示）</div>
            )}
            {!chapters.length && !loadErr && toc?.status !== "failed" && toc?.status !== "fetching" && (
              <div className="p-6 text-center">
                <div className="text-sm text-neutral-500">这本书还没有目录</div>
                <button
                  onClick={refreshToc}
                  disabled={refreshing}
                  className="mt-3 rounded bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 disabled:opacity-50"
                >
                  {refreshing ? "抓取中…" : "抓取目录"}
                </button>
              </div>
            )}
            {loadErr && !chapters.length && <div className="p-6 text-center text-neutral-600">{loadErr}</div>}
          </div>
        )}

        {/* 分页：贴底固定，一页 100 章；页码用 select，几千章也能一步跳到最后一页 */}
        {!loading && totalPages > 1 && (
          <div className="mt-2 flex flex-none items-center justify-center gap-3 text-xs text-neutral-400">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={pageClamped <= 1}
              className="rounded bg-neutral-800 px-3 py-1 hover:bg-neutral-700 disabled:opacity-40"
            >
              上一页
            </button>
            <select
              value={pageClamped}
              onChange={(e) => setPage(Number(e.target.value))}
              className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-300 outline-none hover:bg-neutral-700"
            >
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  第 {n} / {totalPages} 页
                </option>
              ))}
            </select>
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
