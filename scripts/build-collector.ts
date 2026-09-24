import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import packageJson from "../package.json";
import {
  BUNDLE_IDENTIFIER,
  renderServicePlist,
  SERVICE_HELPER,
  SERVICE_PLIST,
} from "../src/collector/launchd";

/**
 * 构建采集器：dist/meterleaf-collector 是通用命令行可执行文件；在 macOS 上另外打包
 * dist/Meterleaf.app。包内带 SMAppService 注册助手与后台任务 plist，
 * 让后台任务在“登录项与扩展”中显示 Meterleaf 名称与图标。
 */
const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");
const binary = join(dist, "meterleaf-collector");
const bundle = join(dist, "Meterleaf.app");

function run(command: string[]) {
  const result = Bun.spawnSync(command, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command[0]} 失败，退出码 ${result.exitCode}`);
  }
}

function runQuiet(command: string[]) {
  const result = Bun.spawnSync(command, {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} 失败: ${result.stderr.toString().trim()}`,
    );
  }
}

function infoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_IDENTIFIER}</string>
  <key>CFBundleName</key>
  <string>Meterleaf</string>
  <key>CFBundleDisplayName</key>
  <string>Meterleaf</string>
  <key>CFBundleExecutable</key>
  <string>meterleaf-collector</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${packageJson.version}</string>
  <key>CFBundleVersion</key>
  <string>${packageJson.version}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>LSBackgroundOnly</key>
  <true/>
</dict>
</plist>
`;
}

/** 以品牌源图 public/favicon.svg 渲染 macOS 图标，四周留出系统图标网格的边距。 */
function buildIcon(destination: string) {
  const work = mkdtempSync(join(tmpdir(), "meterleaf-collector-icon-"));
  try {
    const source = readFileSync(join(root, "public/favicon.svg"), "utf8");
    const padded = source
      .replace('width="64" height="64"', 'width="1024" height="1024"')
      .replace('viewBox="0 0 64 64"', 'viewBox="-7.75 -7.75 79.5 79.5"');
    if (padded === source) {
      throw new Error(
        "public/favicon.svg 的尺寸声明已变化，请同步更新图标构建",
      );
    }
    const svg = join(work, "icon.svg");
    writeFileSync(svg, padded);
    const iconset = join(work, "AppIcon.iconset");
    mkdirSync(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const pixels = size * scale;
        const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
        runQuiet([
          "/usr/bin/sips",
          "-z",
          String(pixels),
          String(pixels),
          "-s",
          "format",
          "png",
          svg,
          "--out",
          join(iconset, name),
        ]);
      }
    }
    runQuiet(["/usr/bin/iconutil", "-c", "icns", iconset, "-o", destination]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

mkdirSync(dist, { recursive: true });
run([
  process.execPath,
  "build",
  "--compile",
  "src/collector/main.ts",
  "--outfile",
  binary,
]);

if (process.platform === "darwin") {
  rmSync(bundle, { recursive: true, force: true });
  const contents = join(bundle, "Contents");
  const macos = join(contents, "MacOS");
  const agents = join(contents, "Library", "LaunchAgents");
  mkdirSync(macos, { recursive: true });
  mkdirSync(join(contents, "Resources"), { recursive: true });
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(contents, "Info.plist"), infoPlist());
  copyFileSync(binary, join(macos, "meterleaf-collector"));
  writeFileSync(join(agents, SERVICE_PLIST), renderServicePlist());
  // SMAppService 需要 macOS 13；目标版本与 Info.plist 的 LSMinimumSystemVersion 一致。
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  run([
    "/usr/bin/xcrun",
    "swiftc",
    "-O",
    "-target",
    `${arch}-apple-macos13.0`,
    "src/collector/macos/meterleaf-service.swift",
    "-o",
    join(macos, SERVICE_HELPER),
  ]);
  buildIcon(join(contents, "Resources", "AppIcon.icns"));
  // 临时签名：先签包内助手，再签整个包，把 Info.plist、plist 与图标封入签名。
  runQuiet([
    "/usr/bin/codesign",
    "--force",
    "--sign",
    "-",
    "--identifier",
    `${BUNDLE_IDENTIFIER}.service`,
    join(macos, SERVICE_HELPER),
  ]);
  runQuiet(["/usr/bin/codesign", "--force", "--sign", "-", bundle]);
  console.log(`已生成 ${bundle}`);
}
console.log(`已生成 ${binary}`);
