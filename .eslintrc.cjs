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
    "import/no-restricted-paths": [
      "error",
      {
        zones: [
          // core may not import from anyone above
          { target: "./src/core", from: "./src/cli" },
          { target: "./src/core", from: "./src/agent" },
          { target: "./src/core", from: "./src/tools" },
          // tools may not import from cli or agent
          { target: "./src/tools", from: "./src/cli" },
          { target: "./src/tools", from: "./src/agent" },
          // agent may not import from cli
          { target: "./src/agent", from: "./src/cli" },
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
