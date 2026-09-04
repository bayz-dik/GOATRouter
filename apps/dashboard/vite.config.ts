import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  test: {
    environment: "jsdom",
    setupFiles: "./test/setup.ts",
    // Default 5s is too tight for the heavy render/diff loops (dense flux
    // transforms, navigation smoke, batch panels) when the whole suite runs in
    // parallel forks on a loaded machine. Each of these tests is a bounded loop
    // that always terminates; the default only makes them flake under load.
    testTimeout: 20000,
  },
});
