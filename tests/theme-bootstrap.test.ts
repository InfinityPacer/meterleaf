import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const script = html.match(
  /<script id="theme-bootstrap">([\s\S]*?)<\/script>/,
)?.[1];

test("theme bootstrap runs before the application module", () => {
  expect(script).toBeDefined();
  expect(html.indexOf('id="theme-bootstrap"')).toBeLessThan(
    html.indexOf('type="module"'),
  );
});

for (const [mode, systemDark, expected] of [
  [null, true, true],
  ["system", true, true],
  ["system", false, false],
  ["dark", false, true],
  ["light", true, false],
  ["invalid", true, true],
] as const) {
  test(`theme bootstrap resolves ${mode} with system dark=${systemDark} before React`, () => {
    const root = {
      dark: false,
      dataset: {} as Record<string, string>,
      classList: {
        toggle: (_name: string, value: boolean) => {
          root.dark = value;
        },
      },
    };
    const meta = { content: "" };
    runInNewContext(script!, {
      localStorage: {
        getItem: (key: string) =>
          key === "meterleaf-theme" ? mode : "natural",
      },
      matchMedia: () => ({ matches: systemDark }),
      document: { documentElement: root, querySelector: () => meta },
    });
    expect(root.dark).toBe(expected);
    expect(root.dataset.palette).toBe("natural");
    expect(meta.content).toBe(expected ? "#171b20" : "#f7f8fa");
  });
}

test("blocked storage still follows system appearance", () => {
  let dark = false;
  runInNewContext(script!, {
    localStorage: {
      getItem: () => {
        throw new Error("blocked");
      },
    },
    matchMedia: () => ({ matches: true }),
    document: {
      documentElement: {
        dataset: {},
        classList: {
          toggle: (_: string, value: boolean) => {
            dark = value;
          },
        },
      },
      querySelector: () => ({ content: "" }),
    },
  });
  expect(dark).toBe(true);
});
