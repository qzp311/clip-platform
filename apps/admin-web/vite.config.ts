import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  base: "/admin/",
  server: {
    port: 5173,
    proxy: {
      "/admin/api": "http://127.0.0.1:8081",
      "/admin-api": "http://127.0.0.1:8081",
      "/oss": "http://127.0.0.1:8081",
    },
  },
});
