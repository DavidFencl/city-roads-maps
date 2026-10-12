import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/city-roads-maps/" : "/",
  server: {
    port: 5173,
  },
}));
