import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";

interface ExploreSource {
  id: number;
  name: string;
  type?: string; // rules / script（脚本源暂不支持探索）
  categories: { title: string; tpl: string }[];
}
interface ExploreBook {
  name: string;
  author: string;
  bookUrl: string;
  cover: string;
  intro: string;
  latestChapter: string;
}

// 探索（分类浏览）：顶部选书源 + 横向滚动分类，下方 flex-1 滚动列表 + 翻页；点卡片与搜索页一样进预览
export default function Explore() {
  const [srcs, setSrcs] = useState<ExploreSource[] | null>(null); // null = 加载中
  const [sid, setSid] = useState(0);
  const [catIdx, setCatIdx] = useState(0);
  const [page, setPage] = useState(1);
  const [books, setBooks] = useState<ExploreBook[] | null>(null); // null = 分类加载中
  const [err, setErr] = useState("");
  const [opening, setOpening] = useState(""); // 正在入库的 bookUrl（防重复点）
  const nav = useNavigate();
  const listRef = useRef<HTMLDivElement | null>(null);

  const cur = srcs?.find((s) => s.id === sid);
  const cat = cur?.categories[catIdx];

  useEffect(() => {
    api<ExploreSource[]>("/api/sources/explore")
      .then((list) => {
        setSrcs(list);
        // 默认选第一个「配了分类」的源（新加的源还没填分类时也留在列表里，但不抢默认）
        const first = list.find((s) => s.categories.length) ?? list[0];
        if (first) setSid(first.id);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setSrcs((s) => s ?? []));
  }, []);

  useEffect(() => {
    if (!sid) return;
    if (!cat) {
      // 选中了还没配分类的源（或脚本源）：不发请求，直接给空列表，空态文案另行提示
      setBooks([]);
      setErr("");
      return;
    }
    let dead = false;
    setBooks(null);
    setErr("");
    api<{ page: number; books: ExploreBook[] }>(
      `/api/sources/${sid}/explore?page=${page}&url=${encodeURIComponent(cat.tpl)}`,
    )
      .then((d) => !dead && setBooks(d.books))
      .catch((e: any) => {
        if (e.name === "AbortError") return;
        !dead && (setErr(e.message), setBooks([]));
      });
    return () => {
      dead = true;
    };
  }, [sid, cat?.tpl, page]);

  // 换源/换分类回到第 1 页
  const pickSource = (id: number) => {
    setSid(id);
    setCatIdx(0);
    setPage(1);
  };
  const pickCat = (i: number) => {
    setCatIdx(i);
    setPage(1);
  };
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [books]);

  const openBook = async (b: ExploreBook) => {
    if (opening) return;
    setOpening(b.bookUrl);
    try {
      // 预览即入库：点卡片先把书写进库（幂等），再进详情页；目录由后端后台补
      const r = await api<{ id: number }>("/api/books/import", {
        method: "POST",
        body: JSON.stringify({
          sourceId: sid,
          bookUrl: b.bookUrl,
          info: { name: b.name, author: b.author, cover: b.cover, intro: b.intro, latestChapter: b.latestChapter },
        }),
      });
      nav(`/book/${r.id}`);
    } catch (e: any) {
      setErr(`入库失败：${e.message}`);
      setOpening("");
    }
  };

  return (
    <div className="mx-auto flex h-dvh max-w-3xl flex-col p-4">
      {/* 顶部两行：①返回书架独占一行 ②书源下拉 + 分类（分类横向滚动、不显示滚动条） */}
      <header className="mb-3 flex-none">
        <div className="mb-2 flex items-center gap-2">
          <Link to="/" className="flex-none text-sm text-neutral-400 hover:text-neutral-200">
            ← 书架
          </Link>
          <h1 className="text-base font-bold">探索</h1>
        </div>
        <div className="flex items-center gap-2">
          {/* select 也 16px：iOS 上同输入框，字号 <16 会聚焦缩放 */}
          <select
            value={sid}
            onChange={(e) => pickSource(Number(e.target.value))}
            className="min-w-0 max-w-40 flex-none rounded-lg bg-neutral-800 px-2 py-1.5 text-base"
          >
            {srcs?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-0.5">
            {cur?.categories.map((cg, i) => (
              <button
                key={i}
                onClick={() => pickCat(i)}
                className={`flex-none rounded-full px-3 py-1.5 text-sm transition-colors ${
                  i === catIdx
                    ? "bg-amber-500 font-medium text-neutral-900"
                    : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                }`}
              >
                {cg.title}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* 列表区：flex-1 内部滚动，换页/换分类自动回顶 */}
      <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {err && <div className="rounded-lg bg-neutral-800 px-3 py-2 text-sm text-amber-400">{err}</div>}
        {!err && srcs !== null && !srcs.length && (
          <div className="p-8 text-center text-neutral-600">还没有启用的书源，去「书源 → 新建」或导入一个</div>
        )}
        {/* 新加的源也会出现在下拉里：没配分类时明确告诉去哪配，而不是一片空白 */}
        {!err && cur && !cur.categories.length && (
          <div className="p-8 text-center text-sm leading-6 text-neutral-500">
            {cur.type === "script" ? (
              <>「{cur.name}」是脚本源，暂不支持探索分类</>
            ) : (
              <>
                「{cur.name}」还没有探索分类
                <br />
                <span className="text-neutral-600">
                  书源列表 → 编辑这个源 →「分类」填 exploreUrl，每行一个：分类名::分类地址
                </span>
              </>
            )}
          </div>
        )}
        {books === null && cur && !!cur.categories.length && (
          <div className="flex h-48 items-center justify-center text-sm text-neutral-500">
            <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-neutral-600 border-t-amber-500" />
            加载中…
          </div>
        )}
        {books?.map((b) => (
          <div
            key={b.bookUrl}
            onClick={() => openBook(b)}
            className={`cursor-pointer rounded-xl bg-neutral-800 p-3 transition-colors hover:bg-neutral-700 ${opening === b.bookUrl ? "opacity-50" : ""}`}
          >
            <div className="flex gap-3">
              {b.cover ? (
                <img
                  src={b.cover}
                  alt=""
                  className="h-20 w-14 flex-none rounded object-cover"
                  onError={(e) => (e.currentTarget.style.display = "none")}
                />
              ) : (
                <div className="flex h-20 w-14 flex-none items-center justify-center rounded bg-neutral-700 text-xl">📕</div>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{b.name}</div>
                <div className="truncate text-xs text-neutral-400">
                  {b.author || "佚名"}
                  {b.latestChapter && ` · ${b.latestChapter}`}
                </div>
                {b.intro && <p className="mt-1 line-clamp-2 text-xs text-neutral-500">{b.intro}</p>}
              </div>
            </div>
          </div>
        ))}
        {books?.length === 0 && !err && cur && !!cur.categories.length && (
          <div className="p-8 text-center text-neutral-600">{page > 1 ? "没有更多了" : "这个分类暂时没有内容"}</div>
        )}
      </div>

      {/* 翻页：下一页可用性看本页结果（抓不到内容即视为到底） */}
      <footer className="mt-3 flex flex-none items-center justify-center gap-4 text-sm">
        <button
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1 || books === null}
          className="rounded-lg bg-neutral-800 px-4 py-2 text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
        >
          上一页
        </button>
        <span className="text-neutral-500">第 {page} 页</span>
        <button
          onClick={() => setPage((p) => p + 1)}
          disabled={!books?.length}
          className="rounded-lg bg-neutral-800 px-4 py-2 text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
        >
          下一页
        </button>
      </footer>
    </div>
  );
}
