// @ts-check
/**
 * @type {import("eslint").Linter.FlatConfig[]}
 */
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";

const tsconfigRootDir = fileURLToPath(new URL("./", import.meta.url));
const recommendedTypeScriptRules = tseslint.configs["recommended"]?.rules ?? {};

/** @type {import("eslint").Linter.FlatConfig[]} */
const config = [
  {
    ignores: ["**/dist/**", "**/node_modules/**"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir,
        sourceType: "module",
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "unused-imports": unusedImports,
    },
    rules: {
      ...recommendedTypeScriptRules,
      curly: ["error", "all"],
      "unused-imports/no-unused-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-type-assertion": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
];

export default config;
