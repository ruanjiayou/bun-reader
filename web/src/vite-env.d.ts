/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// vite.config.ts 的 define 注入：每次构建的时间戳，书架页展示用
declare const __APP_VERSION__: string;
