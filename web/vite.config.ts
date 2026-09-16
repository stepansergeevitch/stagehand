import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    server: {
        // Bind the IPv4 loopback explicitly: with the default ("localhost") Node picks ::1 first on macOS and Vite
        // listens on IPv6 only, which Safari 26 (IPv4 first, no fallback) reports as "can't open the page".
        host: "127.0.0.1",
        port: 5173,
        proxy: {
            "/api": { target: "http://localhost:4747", changeOrigin: true },
            "/ws": { target: "ws://localhost:4747", ws: true },
        },
    },
});
