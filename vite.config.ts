import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "meterleaf-boot-styles",
      apply: "build",
      transformIndexHtml: {
        order: "post",
        // 启动提示使用内联样式，完整样式下载不应阻止它首次绘制。
        handler: (html) =>
          html.replace(/<link\b[^>]*\brel="stylesheet"[^>]*>/g, (link) =>
            link.replace(
              "<link",
              '<link data-app-styles media="print" onload="this.media=\'all\'" onerror="this.dataset.failed=\'true\'"',
            ),
          ),
      },
    },
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src/web", import.meta.url)) },
  },
  server: {
    port: 4317,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.METERLEAF_API_URL ?? "http://127.0.0.1:4318",
      },
    },
  },
  build: { outDir: "dist/web" },
});
