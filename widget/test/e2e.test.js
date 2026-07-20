import { afterAll, beforeAll, describe, expect, test } from "bun:test";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {}

const SHOULD_RUN_E2E = !process.env.SKIP_E2E && chromium;

if (!SHOULD_RUN_E2E) {
  test.skip("e2e tests skipped (set SKIP_E2E=0 and `bun add playwright`)", () => {});
} else {
  const { makeBaseHandler, setLocalWasmHtml } = await import(
    "./test-server.js"
  );
  const { generateChallenge, validateChallenge } = await import(
    "../../core/src/index.js"
  );

  const SECRET = "e2e-test-secret-32-bytes-padding-junk-1234";

  let server;
  let browser;
  let page;
  let baseUrl;
  const tokens = new Map();

  beforeAll(async () => {
    const html = setLocalWasmHtml(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>cap widget e2e</title>
</head>
<body>
<form id="testForm">
  <cap-widget
    id="cap"
    data-cap-api-endpoint="/cap/"
    data-cap-hidden-field-name="cap-token"
  ></cap-widget>
  <button type="submit">submit</button>
</form>
<div id="solveResult"></div>
<div id="errorResult"></div>
<script src="/widget.js"></script>
<script>
  const w = document.getElementById("cap");
  w.addEventListener("solve", (e) => {
    document.getElementById("solveResult").textContent = e.detail.token;
  });
  w.addEventListener("error", (e) => {
    document.getElementById("errorResult").textContent = e.detail.message || "error";
  });
</script>
</body>
</html>`);

    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: makeBaseHandler({
        html,
        onChallenge: async () =>
          await generateChallenge(SECRET, {
            challengeCount: 4,
            challengeSize: 16,
            challengeDifficulty: 2,
            scope: "e2e",
          }),
        onRedeem: async (body) => {
          const result = await validateChallenge(SECRET, body, {
            scope: "e2e",
            consumeNonce: (sigHex) => {
              if (tokens.has(sigHex)) return false;
              tokens.set(sigHex, true);
              return true;
            },
          });
          if (!result.success) {
            return Response.json(
              {
                success: false,
                error: result.reason || "validation failed",
                ...(result.instr_error
                  ? { instr_error: true, reason: result.reason }
                  : {}),
              },
              { status: 403 },
            );
          }
          return Response.json({
            success: true,
            token: result.token,
            expires: result.expires,
          });
        },
      }),
    });
    baseUrl = `http://127.0.0.1:${server.port}`;

    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  }, 120_000);

  afterAll(async () => {
    if (page) await page.close();
    if (browser) await browser.close();
    if (server) server.stop(true);
  });

  describe("widget e2e", () => {
    test("renders the widget", async () => {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      const exists = await page.evaluate(
        () => !!document.getElementById("cap"),
      );
      expect(exists).toBe(true);

      await page.waitForFunction(
        () =>
          document
            .getElementById("cap")
            ?.shadowRoot?.querySelector?.(".cf-captcha"),
        null,
        { timeout: 10_000 },
      );

      const triggerText = await page.evaluate(() => {
        const root = document.getElementById("cap").shadowRoot;
        return root.querySelector(".cf-captcha")?.textContent || "";
      });
      expect(triggerText.length).toBeGreaterThan(0);
    }, 30_000);

    test("renders the accessible cofob design-system contract", async () => {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () =>
          document
            .getElementById("cap")
            ?.shadowRoot?.querySelector?.(".cf-captcha"),
        null,
        { timeout: 10_000 },
      );

      const contract = await page.evaluate(() => {
        const widget = document.getElementById("cap");
        const root = widget.shadowRoot;
        const button = root.querySelector(".cf-captcha");
        widget.setAttribute("data-cap-lang", "ru");
        return {
          tagName: button.tagName,
          state: button.dataset.state,
          labelCount: button.querySelectorAll("[data-captcha-label]").length,
          liveText: button.querySelector(".cf-visually-hidden").textContent,
          translatedLabels: [
            ...button.querySelectorAll("[data-captcha-label]"),
          ].map((label) => label.textContent),
          hasParts: root.querySelectorAll("[part]").length,
          creditsAreSibling:
            root.querySelector(".credits").parentElement ===
            button.parentElement,
        };
      });

      expect(contract).toEqual({
        tagName: "BUTTON",
        state: "idle",
        labelCount: 4,
        liveText: "Я человек",
        translatedLabels: [
          "Я человек",
          "Проверка...",
          "Вы человек",
          "Ошибка. Повторите.",
        ],
        hasParts: 0,
        creditsAreSibling: true,
      });
    }, 30_000);

    test("keeps determinate progress and autonomous theme fallbacks", async () => {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () =>
          document
            .getElementById("cap")
            ?.shadowRoot?.querySelector?.(".cf-captcha"),
        null,
        { timeout: 10_000 },
      );

      const presentation = await page.evaluate(async () => {
        const widget = document.getElementById("cap");
        const root = widget.shadowRoot;
        const button = root.querySelector(".cf-captcha");
        const indicator = root.querySelector(".cf-captcha__indicator");
        const progress = root.querySelector(".cf-captcha__progress-value");
        const offsets = [];

        for (const value of [0, 50, 100]) {
          widget.dispatchEvent("progress", { progress: value });
          offsets.push(Number.parseFloat(progress.style.strokeDashoffset));
        }

        document.documentElement.dataset.theme = "light";
        await new Promise((resolve) => setTimeout(resolve, 250));
        const lightBackground = getComputedStyle(button).backgroundColor;
        document.documentElement.dataset.theme = "dark";
        await new Promise((resolve) => setTimeout(resolve, 250));
        const darkBackground = getComputedStyle(button).backgroundColor;
        widget.dataset.theme = "light";
        await new Promise((resolve) => setTimeout(resolve, 250));
        const directHostTheme = getComputedStyle(button).backgroundColor;
        widget.removeAttribute("data-theme");
        widget.style.setProperty("--cf-color-accent", "rgb(255 0 255)");
        await new Promise((resolve) => setTimeout(resolve, 250));
        const overriddenAccent = getComputedStyle(indicator).color;
        delete document.documentElement.dataset.theme;

        return {
          offsets,
          lightBackground,
          darkBackground,
          directHostTheme,
          overriddenAccent,
        };
      });

      expect(presentation.offsets[0]).toBeCloseTo(2 * Math.PI * 12, 4);
      expect(presentation.offsets[1]).toBeCloseTo(Math.PI * 12, 4);
      expect(presentation.offsets[2]).toBe(0);
      expect(presentation.lightBackground).not.toBe(
        presentation.darkBackground,
      );
      expect(presentation.directHostTheme).toBe(presentation.lightBackground);
      expect(presentation.overriddenAccent).toBe("rgb(255, 0, 255)");

      await page.emulateMedia({ colorScheme: "light" });
      await page.waitForTimeout(250);
      const systemLight = await page.evaluate(
        () =>
          getComputedStyle(
            document
              .getElementById("cap")
              .shadowRoot.querySelector(".cf-captcha"),
          ).backgroundColor,
      );
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForTimeout(250);
      const systemDark = await page.evaluate(
        () =>
          getComputedStyle(
            document
              .getElementById("cap")
              .shadowRoot.querySelector(".cf-captcha"),
          ).backgroundColor,
      );
      expect(systemLight).not.toBe(systemDark);
      await page.emulateMedia({ colorScheme: "light" });
    }, 30_000);

    test("honors reduced motion and forced colors without losing progress", async () => {
      await page.emulateMedia({
        colorScheme: "light",
        forcedColors: "none",
        reducedMotion: "reduce",
      });
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () =>
          document
            .getElementById("cap")
            ?.shadowRoot?.querySelector?.(".cf-captcha"),
        null,
        { timeout: 10_000 },
      );

      const reducedMotion = await page.evaluate(() => {
        const widget = document.getElementById("cap");
        widget.updateUI("verifying", "Verifying...", true);
        widget.dispatchEvent("progress", { progress: 50 });
        const value = widget.shadowRoot.querySelector(
          ".cf-captcha__progress-value",
        );
        return {
          matches: matchMedia("(prefers-reduced-motion: reduce)").matches,
          offset: Number.parseFloat(value.style.strokeDashoffset),
          transitionDuration: getComputedStyle(value).transitionDuration,
        };
      });

      expect(reducedMotion.matches).toBe(true);
      expect(reducedMotion.offset).toBeCloseTo(Math.PI * 12, 4);
      expect(reducedMotion.transitionDuration).toBe("0s");

      await page.emulateMedia({
        colorScheme: "light",
        forcedColors: "active",
        reducedMotion: "no-preference",
      });
      const forcedColors = await page.evaluate(() => {
        const button = document
          .getElementById("cap")
          .shadowRoot.querySelector(".cf-captcha");
        return {
          matches: matchMedia("(forced-colors: active)").matches,
          forcedColorAdjust: getComputedStyle(button).forcedColorAdjust,
          borderStyle: getComputedStyle(button).borderTopStyle,
        };
      });

      expect(forcedColors).toEqual({
        matches: true,
        forcedColorAdjust: "auto",
        borderStyle: "solid",
      });

      await page.emulateMedia({
        colorScheme: "light",
        forcedColors: "none",
        reducedMotion: "no-preference",
      });
    }, 30_000);

    test("keeps troubleshooting and restores protected branding on retry", async () => {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () =>
          document
            .getElementById("cap")
            ?.shadowRoot?.querySelector?.(".cf-captcha"),
        null,
        { timeout: 10_000 },
      );

      const beforeRetry = await page.evaluate(() => {
        const widget = document.getElementById("cap");
        const root = widget.shadowRoot;
        const button = root.querySelector(".cf-captcha");
        widget.updateUIBlocked("Verification failed", true);
        const troubleshoot = root.querySelector(".cap-troubleshoot-link");
        const credits = root.querySelector(".credits");
        const presentation = {
          state: button.dataset.state,
          troubleshootingVisible: !troubleshoot.hidden,
          troubleshootingIsSibling:
            troubleshoot.parentElement === button.parentElement,
        };

        credits.style.display = "none";
        credits.textContent = "";
        credits.remove();
        widget.solve();

        const restoredCredits = root.querySelector(".credits");
        return {
          ...presentation,
          creditsRestored: Boolean(restoredCredits),
          creditsText: restoredCredits?.textContent,
          creditsHref: restoredCredits?.getAttribute("href"),
          creditsDisplay: restoredCredits?.style.display,
        };
      });

      expect(beforeRetry).toEqual({
        state: "error",
        troubleshootingVisible: true,
        troubleshootingIsSibling: true,
        creditsRestored: true,
        creditsText: "Cap",
        creditsHref: "https://trycap.dev",
        creditsDisplay: "inline-flex",
      });

      await page.waitForFunction(
        () => document.getElementById("solveResult").textContent.length > 0,
        null,
        { timeout: 60_000 },
      );
      const finalState = await page.evaluate(
        () =>
          document.getElementById("cap").shadowRoot.querySelector(".cf-captcha")
            .dataset.state,
      );
      expect(finalState).toBe("success");
    }, 90_000);

    test("smoke-tests floating mode with the redesigned widget", async () => {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        const trigger = document.createElement("button");
        trigger.id = "floating-trigger";
        trigger.dataset.capFloating = "#cap";
        trigger.textContent = "Continue";
        document.body.appendChild(trigger);
      });
      await page.addScriptTag({
        path: new URL("../src/cap-floating.min.js", import.meta.url).pathname,
      });
      await page.waitForFunction(
        () => document.getElementById("cap").style.display === "none",
        null,
        { timeout: 10_000 },
      );

      await page.click("#floating-trigger");
      await page.waitForFunction(
        () => {
          const widget = document.getElementById("cap");
          const state =
            widget.shadowRoot.querySelector(".cf-captcha")?.dataset.state;
          return (
            widget.style.display === "block" &&
            (state === "verifying" || state === "success")
          );
        },
        null,
        { timeout: 10_000 },
      );
    }, 30_000);

    test("smoke-tests programmatic mode", async () => {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      const result = await page.evaluate(async () => {
        const cap = new Cap({ apiEndpoint: `${location.origin}/cap/` });
        const solveResult = await cap.solve();
        return {
          display: cap.widget.style.display,
          success: solveResult.success,
          tagName: cap.widget.tagName,
          token: solveResult.token,
        };
      });

      expect(result.display).toBe("none");
      expect(result.success).toBe(true);
      expect(result.tagName).toBe("CAP-WIDGET");
      expect(result.token).toMatch(/^[a-z0-9]+:[a-f0-9]+$/);
    }, 90_000);

    test("clicking solve runs PoW and dispatches solve event", async () => {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () =>
          document
            .getElementById("cap")
            ?.shadowRoot?.querySelector?.(".cf-captcha"),
        null,
        { timeout: 10_000 },
      );

      await page.evaluate(() => {
        const widget = document.getElementById("cap");
        widget.addEventListener(
          "progress",
          () => {
            const button = widget.shadowRoot.querySelector(".cf-captcha");
            window.__verifyingState = {
              state: button.dataset.state,
              busy: button.getAttribute("aria-busy"),
              disabled: button.getAttribute("aria-disabled"),
            };
          },
          { once: true },
        );
        widget.solve();
      });

      await page.waitForFunction(
        () => document.getElementById("solveResult").textContent.length > 0,
        null,
        { timeout: 60_000 },
      );

      const token = await page.evaluate(
        () => document.getElementById("solveResult").textContent,
      );
      expect(token).toMatch(/^[a-z0-9]+:[a-f0-9]+$/);

      const hiddenValue = await page.evaluate(() => {
        const w = document.getElementById("cap");
        return w.querySelector("input[name='cap-token']")?.value;
      });
      expect(hiddenValue).toBe(token);

      const finalState = await page.evaluate(() => {
        const button = document
          .getElementById("cap")
          .shadowRoot.querySelector(".cf-captcha");
        return {
          verifying: window.__verifyingState,
          final: {
            state: button.dataset.state,
            busy: button.getAttribute("aria-busy"),
            disabled: button.getAttribute("aria-disabled"),
          },
        };
      });
      expect(finalState).toEqual({
        verifying: {
          state: "verifying",
          busy: "true",
          disabled: "true",
        },
        final: {
          state: "success",
          busy: null,
          disabled: "true",
        },
      });
    }, 90_000);

    test("native keyboard activation solves the widget", async () => {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () =>
          document
            .getElementById("cap")
            ?.shadowRoot?.querySelector?.(".cf-captcha"),
        null,
        { timeout: 10_000 },
      );

      await page.evaluate(() =>
        document
          .getElementById("cap")
          .shadowRoot.querySelector(".cf-captcha")
          .focus(),
      );
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => document.getElementById("solveResult").textContent.length > 0,
        null,
        { timeout: 60_000 },
      );

      expect(
        await page.evaluate(
          () =>
            document.getElementById("cap").shadowRoot.activeElement?.tagName,
        ),
      ).toBe("BUTTON");
    }, 90_000);

    test("speculative solve completes after interaction", async () => {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () =>
          document
            .getElementById("cap")
            ?.shadowRoot?.querySelector?.(".cf-captcha"),
        null,
        { timeout: 10_000 },
      );

      await page.mouse.move(100, 100);
      await page.mouse.move(200, 200);

      await page.evaluate(() => document.getElementById("cap").solve());
      await page.waitForFunction(
        () => document.getElementById("solveResult").textContent.length > 0,
        null,
        { timeout: 60_000 },
      );
    }, 90_000);

    test("widget exposes token via .token property after solve", async () => {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () =>
          document
            .getElementById("cap")
            ?.shadowRoot?.querySelector?.(".cf-captcha"),
        null,
        { timeout: 10_000 },
      );
      await page.evaluate(() => document.getElementById("cap").solve());
      await page.waitForFunction(
        () => document.getElementById("solveResult").textContent.length > 0,
        null,
        { timeout: 60_000 },
      );
      const tokenViaProp = await page.evaluate(
        () => document.getElementById("cap").token,
      );
      expect(typeof tokenViaProp).toBe("string");
      expect(tokenViaProp.length).toBeGreaterThan(0);
    }, 90_000);
  });
}
