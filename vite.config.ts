import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/web",
  plugins: [tailwindcss()],
  esbuild: {
    jsx: "automatic",
  },
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4080",
    },
  },
});
