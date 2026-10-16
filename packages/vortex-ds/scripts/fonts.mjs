// Ships the IBM Plex files next to the stylesheet: vite's library mode would inline them as base64 in index.css, so the
// @font-face rules (src/fonts.css, urls relative to ./fonts/) are appended to dist/index.css and the files copied.
import { appendFileSync, cpSync, readFileSync } from "node:fs";
cpSync("src/fonts", "dist/fonts", { recursive: true });
appendFileSync("dist/index.css", `\n${readFileSync("src/fonts.css", "utf8")}`);
