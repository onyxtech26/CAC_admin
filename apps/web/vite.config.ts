import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Honour a PORT supplied by the environment so the dev server can be started
  // on an assigned port when 5173 is already taken; falls back to Vite's default.
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    // The enquiry form posts to /api/enquiries, which is served by the staff platform. Proxied in
    // development so the form works end to end on one machine without CORS or configuration; in a
    // deployment the same path is either routed there by the edge or pointed at an absolute URL
    // with VITE_ENQUIRY_ENDPOINT. The staff app allows this origin explicitly — see the route.
    proxy: {
      "/api": {
        target: process.env.STAFF_ORIGIN ?? "http://localhost:3100",
        changeOrigin: false,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
