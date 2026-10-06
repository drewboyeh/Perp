import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // Hermes requires an API key for price updates. The dev/preview server proxies /hermes and
  // adds the key server-side, so it never ships to the browser.
  const { PYTH_API_KEY, HERMES_URL } = loadEnv(mode, process.cwd(), "");
  const proxy = {
    "/hermes": {
      target: HERMES_URL || "https://hermes.pyth.network",
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/hermes/, ""),
      headers: PYTH_API_KEY ? { Authorization: `Bearer ${PYTH_API_KEY}` } : {},
    },
  };
  return {
    plugins: [react()],
    server: { port: 5173, proxy },
    preview: { proxy },
  };
});
