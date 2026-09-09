import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AboutPage } from "../src/web/components/AboutPage";

test("about combines product information with graphical preferences without a profile or glossary", () => {
  const html = renderToStaticMarkup(
    <AboutPage
      mode="live"
      mobileLayout="app"
      onMobileLayoutChange={() => {}}
      onResolvedChange={() => {}}
    />,
  );
  expect(html).toContain("实时 API");
  expect(html).toContain("Apache-2.0");
  expect(html).toContain("InfinityPacer/meterleaf");
  expect(html).toContain('role="group" aria-label="页面布局"');
  expect(html).toContain('role="group" aria-label="外观"');
  expect(html).toContain('role="group" aria-label="配色"');
  expect(html).not.toContain("常用术语");
  expect(html).not.toContain("profile-monogram");
  expect(html).not.toContain('role="combobox"');
  expect(html).not.toContain("USD 估算口径");
  expect(html).not.toContain("计价说明");
  expect(html).not.toContain("订阅等价");
  expect(html).not.toContain("标准 API");
});

test("about never labels an unread data source as a demo", () => {
  const html = renderToStaticMarkup(<AboutPage onResolvedChange={() => {}} />);
  expect(html).toContain("尚未读取");
  expect(html).not.toContain("本地演示");
});
