import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const eslintConfig = [...nextCoreWebVitals, ...nextTypescript, {
  rules: {
    // TypeScript rules
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
    "@typescript-eslint/ban-ts-comment": "off",
    "@typescript-eslint/prefer-as-const": "off",
    "@typescript-eslint/no-unused-disable-directive": "off",
    
    // React rules
    "react-hooks/exhaustive-deps": "off",
    "react-hooks/purity": "off",
    "react/no-unescaped-entities": "off",
    "react/display-name": "off",
    "react/prop-types": "off",
    "react-compiler/react-compiler": "off",
    
    // Next.js rules
    "@next/next/no-img-element": "off",
    "@next/next/no-html-link-for-pages": "off",
    
    // General JavaScript rules
    "prefer-const": "off",
    "no-unused-vars": "off",
    "no-console": "off",
    "no-debugger": "off",
    "no-empty": "off",
    "no-irregular-whitespace": "off",
    "no-case-declarations": "off",
    "no-fallthrough": "off",
    "no-mixed-spaces-and-tabs": "off",
    "no-redeclare": "off",
    "no-undef": "off",
    "no-unreachable": "off",
    "no-useless-escape": "off",
  },
}, {
  files: ["apps/desktop/src/**/*.{ts,tsx}"],
  ignores: ["apps/desktop/src/ui/Button.tsx"],
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector: "JSXAttribute[name.name='style'] Property[key.name='fontSize']",
        message: "Use the desktop type-scale utilities instead of inline fontSize styles.",
      },
      {
        selector: "Literal[value=/text-\\[[0-9.]+px\\]/]",
        message: "Use a named desktop type-scale utility instead of an arbitrary pixel size.",
      },
      {
        selector: "JSXOpeningElement[name.name='button']",
        message: "Use the shared Button or IconButton component.",
      },
      {
        selector: "JSXOpeningElement[name.name=/^[a-z]/] > JSXAttribute[name.name='title']",
        message: "Use data-tooltip or the shared Tooltip component instead of a native browser tooltip.",
      },
      {
        selector: "JSXOpeningElement[name.name=/^(Button|IconButton)$/] > JSXAttribute[name.name='title']",
        message: "Use data-tooltip or the shared Tooltip component instead of a native browser tooltip.",
      },
    ],
  },
}, {
  ignores: [
    "node_modules/**",
    ".next/**",
    ".worktrees/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "examples/**",
    "skills",
    "apps/desktop/**",
    "crates/**/target/**",
    "target/**",
    "python/**/.venv/**",
    "python/**/*.venv/**",
    "vendor/**",
    ".terminus-data/**",
    "packages/terminus-kernel-client/src/generated/**",
    "mini-services/terminus-kernel/src/generated/**",
    "schemas/generated/**",
    "docs/generated/**",
  ]
}];

export default eslintConfig;
