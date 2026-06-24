import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite serves the UI in dev and proxies API calls to the Express server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
