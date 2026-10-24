import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";

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
  const [refreshing, setRefreshing] = useState(false);

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
      setMsg(e.message);
    }
  };
  useEffect(() => {
    load();
  }, [bookId]);

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
        <button onClick={refreshToc} disabled={refreshing} className="ml-auto rounded-lg bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700 disabled:opacity-50">
          {refreshing ? "检查更新中…" : "↻ 检查更新"}
        </button>
        <button onClick={remove} className="rounded-lg bg-neutral-800 px-3 py-1.5 text-sm text-red-400 hover:bg-red-950">移出书架</button>
      </header>
      {msg && <div className="mb-3 rounded-lg bg-neutral-800 px-3 py-2 text-sm text-amber-400">{msg}</div>}

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
            {book.latestChapter && <div className="mt-0.5 truncate text-xs text-neutral-500">最新：{book.latestChapter}</div>}
            {book.intro && <p className="mt-2 line-clamp-3 text-xs text-neutral-500">{book.intro}</p>}
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => nav(`/book/${bookId}/read/${startIdx}`)}
                className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-amber-400"
              >
                {cur !== null ? `继续阅读 · ${chapters.find((c) => c.idx === cur)?.title ?? ""}` : "开始阅读"}
              </button>
              <a href="#toc" className="rounded-lg bg-neutral-700 px-4 py-2 text-sm hover:bg-neutral-600">目录（{chapters.length}）</a>
            </div>
          </div>
        </div>
      )}

      <section id="toc">
        <div className="mb-2 flex items-center">
          <h2 className="text-sm font-bold text-neutral-300">目录</h2>
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
              {ch.idx === cur && <span className="ml-2 text-xs text-neutral-500">· 上次读到</span>}
            </Link>
          ))}
          {!chapters.length && !msg && <div className="p-6 text-center text-neutral-600">目录加载中…</div>}
        </div>
      </section>
    </div>
  );
}
