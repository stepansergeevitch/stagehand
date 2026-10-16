import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Library build: ESM + one stylesheet (tokens and component styles) in dist/; declarations come from tsc (build script).
export default defineConfig({
    plugins: [react()],
    build: {
        lib: { entry: "src/index.ts", formats: ["es"], fileName: () => "index.js", cssFileName: "index" },
        cssCodeSplit: false,
        rollupOptions: { external: ["react", "react-dom", "react/jsx-runtime"] },
    },
});
