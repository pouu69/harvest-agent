/* eslint-env node */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
  plugins: ["@typescript-eslint", "import"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  ignorePatterns: ["dist/", "node_modules/", "coverage/", ".vitest/"],
  rules: {
    // Enforce CLI -> Agent -> Tools -> Core layered import direction (per harvest.md §14.2).
    // A layer may only import from layers strictly to the right of itself.
    // `claudemd/` sits at the same level as `cli/` (it edits user-facing files
    // and is imported only by `cli/`); it can import from `core/` only.
    "import/no-restricted-paths": [
      "error",
      {
        zones: [
          // core may not import from anyone above
          { target: "./src/core", from: "./src/cli" },
          { target: "./src/core", from: "./src/agent" },
          { target: "./src/core", from: "./src/tools" },
          { target: "./src/core", from: "./src/claudemd" },
          // tools may not import from cli, agent, or claudemd
          { target: "./src/tools", from: "./src/cli" },
          { target: "./src/tools", from: "./src/agent" },
          { target: "./src/tools", from: "./src/claudemd" },
          // agent may not import from cli or claudemd
          { target: "./src/agent", from: "./src/cli" },
          { target: "./src/agent", from: "./src/claudemd" },
          // claudemd may not import from cli (cli imports claudemd, not vice versa)
          { target: "./src/claudemd", from: "./src/cli" },
          { target: "./src/claudemd", from: "./src/agent" },
          { target: "./src/claudemd", from: "./src/tools" },
        ],
      },
    ],
  },
  overrides: [
    {
      files: ["*.cjs"],
      env: { node: true },
    },
  ],
};
