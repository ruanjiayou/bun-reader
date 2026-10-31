import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";

// 兼容旧入口：以前 /preview?sourceId=&bookUrl= 是不落库的预览页，
// 现在「预览即入库」，这里只负责把书入库再跳到统一的详情页 /book/:id。
type Hint = { name?: string; author?: string; cover?: string; intro?: string; latestChapter?: string };

export default function Preview() {
  const [sp] = useSearchParams();
  const loc = useLocation();
  const nav = useNavigate();
  const hint = (loc.state ?? {}) as Hint;
  const [err, setErr] = useState("");

  useEffect(() => {
    const sourceId = Number(sp.get("sourceId"));
    const bookUrl = sp.get("bookUrl") ?? "";
    if (!sourceId || !bookUrl) {
      setErr("缺少 sourceId/bookUrl");
      return;
    }
    let dead = false;
    api<{ id: number }>("/api/books/import", {
      method: "POST",
      body: JSON.stringify({ sourceId, bookUrl, info: hint }),
    })
      .then((r) => !dead && nav(`/book/${r.id}`, { replace: true }))
      .catch((e: any) => !dead && setErr(e.message));
    return () => {
      dead = true;
    };
  }, []);

  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl items-center justify-center p-4 text-sm text-neutral-500">
      {err ? (
        <div className="text-center">
          <div className="text-amber-400">{err}</div>
          <Link to="/search" className="mt-2 inline-block text-neutral-400 hover:text-neutral-200">← 回搜索</Link>
        </div>
      ) : (
        "正在打开…"
      )}
    </div>
  );
}
