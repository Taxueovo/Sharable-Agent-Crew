import { defineConfig, globalIgnores } from "eslint/config";
import eslint from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  globalIgnores([
    ".next/**",
    "dist/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  react.configs.flat.recommended,
  react.configs.flat["jsx-runtime"],
  reactHooks.configs.flat["recommended-latest"],
  jsxA11y.flatConfigs.recommended,
  {
    rules: {
      // This app restores persisted state (user name, team, managed links) and
      // clears loading state inside mount/effect bodies; the rule would force
      // microtask indirection for no benefit here.
      "react-hooks/set-state-in-effect": "off",
      // JSX text nodes are escaped by React at render time; plain quotes in
      // English UI copy (it's, don't, ...) are not an injection vector.
      "react/no-unescaped-entities": "off",
      // autoFocus on the message input is a deliberate UX choice.
      "jsx-a11y/no-autofocus": "off",
      // Clicking the modal backdrop to close a dialog is an accepted pattern;
      // the backdrop is non-visual and keyboard users close via the button.
      "jsx-a11y/no-noninteractive-element-interactions": "off",
    },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.serviceworker,
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
  },
]);

export default eslintConfig;
