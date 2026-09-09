import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
