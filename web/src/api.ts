// 统一 API 封装：带 cookie、非 2xx 抛错
export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error ?? `请求失败 ${res.status}`);
  return data as T;
}

// 最新章节展示：详情抓到标题显示标题；库里只有链接（历史数据/标题取不到）时兜底显示页码
export const fmtLatest = (s: string) => {
  if (/^(https?:)?\/\//i.test(s) || s.startsWith("/")) {
    const m = s.match(/(\d+)(?:\.html?)?\/?$/i);
    if (m) return `第 ${m[1]} 页`;
  }
  return s;
};
