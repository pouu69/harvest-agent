import { defineConfig } from "tsup";

export default defineConfig({
  entry: { harvest: "src/cli/index.ts" },
  format: ["esm"],
  target: "node20",
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  minify: false,
  banner: { js: "#!/usr/bin/env node" },
});
