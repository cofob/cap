import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import postcss from "postcss";

const require = createRequire(import.meta.url);

export const DESIGN_SYSTEM_VERSION = "0.1.0";

const CAPTCHA_SELECTOR = /\.cf-captcha(?:\b|__|--)/;
const ACCESSIBLE_SELECTOR = /\.cf-(?:visually-hidden|sr-only)\b/;
const CAPTCHA_KEYFRAMES = /^cf-captcha-/;
const TOKEN_REFERENCE = /var\(\s*(--cf-[\w-]+)\s*\)/g;

function resolveDesignSystemRoot() {
  return path.dirname(require.resolve("@cofob/design-system-css/package.json"));
}

function isRelevantRule(rule) {
  return (
    CAPTCHA_SELECTOR.test(rule.selector) ||
    ACCESSIBLE_SELECTOR.test(rule.selector)
  );
}

function cloneRelevantNode(node) {
  if (node.type === "rule") {
    return isRelevantRule(node) ? node.clone() : null;
  }

  if (node.type === "atrule" && node.name.toLowerCase().endsWith("keyframes")) {
    return CAPTCHA_KEYFRAMES.test(node.params) ? node.clone() : null;
  }

  if (!node.nodes) return null;

  const clone = node.clone({ nodes: [] });
  for (const child of node.nodes) {
    const relevant = cloneRelevantNode(child);
    if (relevant) clone.append(relevant);
  }

  return clone.nodes.length > 0 ? clone : null;
}

function extractComponentContract(css) {
  const source = postcss.parse(css);
  const extracted = postcss.root();

  for (const node of source.nodes) {
    const relevant = cloneRelevantNode(node);
    if (relevant) extracted.append(relevant);
  }

  return extracted;
}

function collectTokenMaps(css) {
  const root = postcss.parse(css);
  const maps = {
    base: new Map(),
    light: new Map(),
    dark: new Map(),
  };

  root.walkRules((rule) => {
    const selector = rule.selector.replaceAll(/\s+/g, "");
    const inDarkMedia =
      rule.parent?.type === "atrule" &&
      rule.parent.name === "media" &&
      /prefers-color-scheme\s*:\s*dark/.test(rule.parent.params);

    let target;
    if (selector.includes(":root[data-theme=dark]") || inDarkMedia) {
      target = maps.dark;
    } else if (selector.includes(":root[data-theme=light]")) {
      target = maps.light;
    } else if (selector === ":root") {
      target = maps.base;
    } else {
      return;
    }

    rule.walkDecls(/^--cf-/, (declaration) => {
      target.set(declaration.prop, declaration.value);
    });
  });

  return maps;
}

function collectTokenUsage(root) {
  const used = new Set();
  const locallyDefined = new Set();

  root.walkDecls((declaration) => {
    if (declaration.prop.startsWith("--cf-")) {
      locallyDefined.add(declaration.prop);
    }

    for (const match of declaration.value.matchAll(/var\(\s*(--cf-[\w-]+)/g)) {
      used.add(match[1]);
    }
  });

  return { used, locallyDefined };
}

function privateTokenName(token) {
  return `--_cap-ds-${token.slice("--cf-".length)}`;
}

function createFallbackRules(referencedTokens, maps) {
  const root = postcss.root();
  const host = postcss.rule({ selector: ":host" });
  const systemDarkHost = postcss.rule({ selector: ":host" });
  const ancestorLight = postcss.rule({
    selector: ':host-context([data-theme="light"])',
  });
  const ancestorDark = postcss.rule({
    selector: ':host-context([data-theme="dark"])',
  });
  const explicitLight = postcss.rule({
    selector: ':host([data-theme="light"])',
  });
  const explicitDark = postcss.rule({
    selector: ':host([data-theme="dark"])',
  });

  host.append({ prop: "color-scheme", value: "light dark" });
  ancestorLight.append({ prop: "color-scheme", value: "light" });
  ancestorDark.append({ prop: "color-scheme", value: "dark" });
  explicitLight.append({ prop: "color-scheme", value: "light" });
  explicitDark.append({ prop: "color-scheme", value: "dark" });
  systemDarkHost.append({ prop: "color-scheme", value: "dark" });

  for (const token of [...referencedTokens].sort()) {
    const base = maps.base.get(token);
    const light = maps.light.get(token) ?? base;
    const dark = maps.dark.get(token) ?? light;
    const fallback = light ?? dark;
    if (!fallback) continue;

    const privateName = privateTokenName(token);
    host.append({ prop: privateName, value: fallback });

    if (dark && dark !== fallback) {
      systemDarkHost.append({ prop: privateName, value: dark });
      ancestorLight.append({ prop: privateName, value: fallback });
      ancestorDark.append({ prop: privateName, value: dark });
      explicitLight.append({ prop: privateName, value: fallback });
      explicitDark.append({ prop: privateName, value: dark });
    }
  }

  root.append(host);
  if (systemDarkHost.nodes.length > 1) {
    const media = postcss.atRule({
      name: "media",
      params: "(prefers-color-scheme: dark)",
    });
    media.append(systemDarkHost);
    root.append(media);
  }
  if (ancestorLight.nodes.length > 1) root.append(ancestorLight);
  if (ancestorDark.nodes.length > 1) root.append(ancestorDark);
  if (explicitLight.nodes.length > 1) root.append(explicitLight);
  if (explicitDark.nodes.length > 1) root.append(explicitDark);

  return root;
}

function addTokenFallbacks(root, maps, locallyDefined) {
  const availableTokens = new Set([
    ...maps.base.keys(),
    ...maps.light.keys(),
    ...maps.dark.keys(),
  ]);
  const unresolved = new Set();

  root.walkDecls((declaration) => {
    declaration.value = declaration.value.replace(
      TOKEN_REFERENCE,
      (original, token) => {
        if (!availableTokens.has(token)) {
          if (!locallyDefined.has(token)) unresolved.add(token);
          return original;
        }
        return `var(${token}, var(${privateTokenName(token)}))`;
      },
    );
  });

  if (unresolved.size > 0) {
    throw new Error(
      `Design-system tokens have no fallback: ${[...unresolved].sort().join(", ")}`,
    );
  }
}

export async function extractCaptchaDesignSystemCss(
  adapterCss,
  { packageRoot = resolveDesignSystemRoot() } = {},
) {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
  );
  if (packageJson.version !== DESIGN_SYSTEM_VERSION) {
    throw new Error(
      `Expected @cofob/design-system-css@${DESIGN_SYSTEM_VERSION}, received ${packageJson.version}`,
    );
  }

  const [componentsCss, tokensCss] = await Promise.all([
    fs.readFile(path.join(packageRoot, "dist", "components.css"), "utf8"),
    fs.readFile(path.join(packageRoot, "dist", "tokens.css"), "utf8"),
  ]);

  const contract = extractComponentContract(componentsCss);
  const adapter = postcss.parse(adapterCss);
  const combined = postcss.root();
  combined.append(contract.nodes);
  combined.append(adapter.nodes);

  const maps = collectTokenMaps(tokensCss);
  const { used, locallyDefined } = collectTokenUsage(combined);
  addTokenFallbacks(combined, maps, locallyDefined);

  const fallbacks = createFallbackRules(used, maps);
  fallbacks.append(combined.nodes);

  return {
    css: fallbacks.toString(),
    packageVersion: packageJson.version,
    referencedTokens: [...used].sort(),
  };
}
