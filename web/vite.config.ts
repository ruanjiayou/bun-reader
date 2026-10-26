import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// 访问 / 或 /reader（无尾斜杠）时 302 到 /reader/，覆盖 vite dev 和 vite preview，
// 免得显示 "did you mean to visit /reader/" 提示页
const redirectToBase = (): Plugin => {
  const middleware = (req: { url?: string }, res: { writeHead: Function; end: Function }, next: Function) => {
    if (req.url === "/" || req.url === "/reader") {
      res.writeHead(302, { Location: "/reader/" });
      res.end();
    } else next();
  };
  return {
    name: "redirect-to-base",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
};

export default defineConfig({
  base: "/reader/",
  plugins: [
    react(),
    tailwindcss(),
    redirectToBase(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "bun-reader",
        short_name: "阅读",
        start_url: "/reader/",
        scope: "/reader/",
        display: "standalone",
        background_color: "#1a1a1a",
        theme_color: "#1a1a1a",
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      },
    }),
  ],
  build: {
    outDir: 'reader'
  },
  server: {
    host: true, // 监听 0.0.0.0，允许局域网通过 http://<本机IP>:5173/reader/ 访问
    proxy: {
      // API 走网关前缀 /gw/reader，dev 原样转发到 192.168.1.124（网关不剥前缀）
      "/gw/reader": { target: "http://192.168.1.124", changeOrigin: true },
      // 兜底：.env 里 VITE_API_BASE 置空串时直连本地后端
      "/api": "http://localhost:8094",
      "/auth": "http://localhost:8094",
    },
  },
  preview: {
    host: true,
  },
});
