import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import postcss from "postcss";
import {
  DESIGN_SYSTEM_VERSION,
  extractCaptchaDesignSystemCss,
} from "../extract-design-system-css.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adapterCss = await fs.readFile(
  path.join(__dirname, "..", "src", "src", "cap.css"),
  "utf8",
);
const extracted = await extractCaptchaDesignSystemCss(adapterCss);
const widgetBundle = await fs.readFile(
  path.join(__dirname, "..", "src", "cap.min.js"),
);

describe("cofob design-system captcha extraction", () => {
  test("pins and extracts the intended public component contract", () => {
    expect(extracted.packageVersion).toBe(DESIGN_SYSTEM_VERSION);
    expect(extracted.css).toContain(".cf-captcha");
    expect(extracted.css).toContain(".cf-captcha__indicator");
    expect(extracted.css).toContain(".cf-visually-hidden");
    expect(extracted.css).toContain("@keyframes cf-captcha-shake");
    expect(extracted.css).toContain("prefers-reduced-motion");
    expect(extracted.css).toContain("forced-colors");
  });

  test("does not pull unrelated design-system components", () => {
    expect(extracted.css).not.toContain(".cf-button");
    expect(extracted.css).not.toContain(".cf-card");
    expect(extracted.css).not.toContain(".cf-navbar");
  });

  test("embeds autonomous fallbacks while preserving public token overrides", () => {
    expect(extracted.css).toContain("--_cap-ds-color-surface-raised");
    expect(extracted.css).toContain(
      "var(--cf-color-surface-raised, var(--_cap-ds-color-surface-raised))",
    );
    expect(extracted.css).toContain(':host-context([data-theme="light"])');
    expect(extracted.css).toContain(':host-context([data-theme="dark"])');
    expect(extracted.referencedTokens.length).toBeGreaterThan(20);

    const root = postcss.parse(extracted.css);
    const locallyDefined = new Set();
    const missingFallbacks = new Set();
    root.walkDecls((declaration) => {
      if (declaration.prop.startsWith("--cf-")) {
        locallyDefined.add(declaration.prop);
      }
    });
    root.walkDecls((declaration) => {
      for (const match of declaration.value.matchAll(
        /var\(\s*(--cf-[\w-]+)/g,
      )) {
        const token = match[1];
        if (locallyDefined.has(token)) continue;
        const privateToken = `--_cap-ds-${token.slice("--cf-".length)}`;
        if (
          !declaration.value.includes(`var(${token}, var(${privateToken}))`)
        ) {
          missingFallbacks.add(token);
        }
      }
    });
    expect([...missingFallbacks]).toEqual([]);
  });

  test("keeps the redesign within the agreed gzip budget", () => {
    const previousBundleGzipBytes = 14_828;
    expect(gzipSync(widgetBundle, { level: 9 }).byteLength).toBeLessThanOrEqual(
      previousBundleGzipBytes + 4_096,
    );
  });
});
