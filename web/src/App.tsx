import { useEffect, useState } from "react";
import { Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { api } from "./api";
import Auth from "./pages/Auth";
import Shelf from "./pages/Shelf";
import Sources from "./pages/Sources";
import { Stub } from "./pages/Stubs";

export function useAuth() {
  const [me, setMe] = useState<{ uid: number; username: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = () =>
    api<{ uid: number; username: string }>("/auth/me")
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  useEffect(refresh, []);
  return { me, loading, refresh };
}

function Guard({ children, me, loading }: any) {
  if (loading) return <div className="p-8 text-center text-neutral-500">加载中…</div>;
  return me ? children : <Navigate to="/auth" replace />;
}

export default function App() {
  const { me, loading, refresh } = useAuth();
  const nav = useNavigate();
  const logout = async () => {
    await api("/auth/logout", { method: "POST" });
    refresh();
    nav("/auth");
  };
  return (
    <Routes>
      <Route path="/auth" element={me ? <Navigate to="/" replace /> : <Auth onOk={refresh} />} />
      <Route path="/" element={<Guard me={me} loading={loading}><Shelf username={me?.username} onLogout={logout} /></Guard>} />
      <Route path="/search" element={<Guard me={me} loading={loading}><Stub title="搜索" milestone="M3" /></Guard>} />
      <Route path="/book/:id" element={<Guard me={me} loading={loading}><Stub title="书籍详情" milestone="M3" /></Guard>} />
      <Route path="/book/:id/category" element={<Guard me={me} loading={loading}><Stub title="目录" milestone="M3" /></Guard>} />
      <Route path="/book/:id/read/:idx" element={<Guard me={me} loading={loading}><Stub title="阅读器" milestone="M3" /></Guard>} />
      <Route path="/sources" element={<Guard me={me} loading={loading}><Sources /></Guard>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
