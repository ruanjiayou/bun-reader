import { useEffect, useState } from "react";
import { Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { api } from "./api";
import Auth from "./pages/Auth";
import Shelf from "./pages/Shelf";
import Sources from "./pages/Sources";
import Search from "./pages/Search";
import Preview from "./pages/Preview";
import Book from "./pages/Book";
import Reader from "./pages/Reader";
import Settings from "./pages/Settings";

export interface Me {
  uid: number;
  username: string;
  nickname?: string | null;
  avatar?: string | null;
}

export function useAuth() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = () =>
    api<Me>("/auth/me")
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  useEffect(() => {
    refresh();
  }, []);
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
      <Route path="/" element={<Guard me={me} loading={loading}><Shelf me={me} onLogout={logout} /></Guard>} />
      <Route path="/settings" element={<Guard me={me} loading={loading}><Settings me={me!} onSaved={refresh} /></Guard>} />
      <Route path="/search" element={<Guard me={me} loading={loading}><Search /></Guard>} />
      <Route path="/preview" element={<Guard me={me} loading={loading}><Preview /></Guard>} />
      <Route path="/book/:id" element={<Guard me={me} loading={loading}><Book /></Guard>} />
      <Route path="/book/:id/category" element={<Guard me={me} loading={loading}><Book /></Guard>} />
      <Route path="/book/:id/read/:idx" element={<Guard me={me} loading={loading}><Reader /></Guard>} />
      <Route path="/sources" element={<Guard me={me} loading={loading}><Sources /></Guard>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
