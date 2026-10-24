import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";
import { registerSW } from "virtual:pwa-register";

registerSW({ immediate: true });

// 不用 StrictMode：开发模式下它会把每个 effect 双跑一遍，导致书源详情等远端请求重复发送
createRoot(document.getElementById("root")!).render(
  <BrowserRouter basename="/reader">
    <App />
  </BrowserRouter>,
);
