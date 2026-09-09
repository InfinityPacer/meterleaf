#!/usr/bin/env swift

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let fileManager = FileManager.default
let root = URL(fileURLWithPath: fileManager.currentDirectoryPath, isDirectory: true)
let source = root.appendingPathComponent("public/favicon.svg")
let outputDirectory = root.appendingPathComponent("public/icons", isDirectory: true)
let temporaryDirectory = URL(
  fileURLWithPath: NSTemporaryDirectory(),
  isDirectory: true,
).appendingPathComponent("meterleaf-pwa-icons-\(UUID().uuidString)", isDirectory: true)
let sizes = [180, 192, 512]

guard fileManager.fileExists(atPath: source.path) else {
  fatalError("Missing canonical asset: \(source.path)")
}

try fileManager.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
try fileManager.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
defer {
  try? fileManager.removeItem(at: temporaryDirectory)
}

// 系统负责裁切桌面图标，底色铺满画布；叶柄保留在 maskable 安全区内。
let document = try XMLDocument(contentsOf: source)
guard
  let background = try document.nodes(forXPath: "//*[local-name()='rect']").first as? XMLElement,
  let mark = try document.nodes(forXPath: "//*[local-name()='g']").first as? XMLElement
else {
  fatalError("Missing icon background or leaf paths")
}
background.removeAttribute(forName: "rx")
mark.addAttribute(XMLNode.attribute(withName: "transform", stringValue: "translate(1.92 1.92) scale(0.94)") as! XMLNode)
let appIconSource = temporaryDirectory.appendingPathComponent("app-icon.svg")
try document.xmlData.write(to: appIconSource)

func runSips(size: Int, output: URL) throws {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/sips")
  process.arguments = [
    "-z",
    String(size),
    String(size),
    "-s",
    "format",
    "png",
    appIconSource.path,
    "--out",
    output.path,
  ]
  process.standardOutput = FileHandle.nullDevice
  process.standardError = FileHandle.nullDevice
  try process.run()
  process.waitUntilExit()
  guard process.terminationStatus == 0 else {
    throw NSError(
      domain: "MeterleafIconExport",
      code: Int(process.terminationStatus),
      userInfo: [NSLocalizedDescriptionKey: "sips failed for \(size)x\(size)"],
    )
  }
}

func flatten(source raster: URL, to destination: URL, size: Int) throws {
  guard
    let imageSource = CGImageSourceCreateWithURL(raster as CFURL, nil),
    let image = CGImageSourceCreateImageAtIndex(imageSource, 0, nil),
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)
  else {
    throw NSError(
      domain: "MeterleafIconExport",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: "Unable to rasterize \(raster.path)"],
    )
  }

  var pixels = [UInt8](repeating: 0, count: size * size * 4)
  var rendered = false
  pixels.withUnsafeMutableBytes { buffer in
    guard
      let context = CGContext(
        data: buffer.baseAddress,
        width: size,
        height: size,
        bitsPerComponent: 8,
        bytesPerRow: size * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue,
      )
    else {
      return
    }

    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: size, height: size))
    rendered = true
  }
  guard rendered else {
    throw NSError(
      domain: "MeterleafIconExport",
      code: 4,
      userInfo: [NSLocalizedDescriptionKey: "Unable to create raster context"],
    )
  }

  // PNG 保持不透明，避免系统蒙版外出现透明边缘。
  let backgroundOffset = ((size / 10) * size + size / 2) * 4
  let background = Array(pixels[backgroundOffset..<(backgroundOffset + 3)])
  for offset in stride(from: 0, to: pixels.count, by: 4) {
    let alpha = Int(pixels[offset + 3])
    let inverseAlpha = 255 - alpha
    pixels[offset] = UInt8(min(255, Int(pixels[offset]) + (Int(background[0]) * inverseAlpha + 127) / 255))
    pixels[offset + 1] = UInt8(min(255, Int(pixels[offset + 1]) + (Int(background[1]) * inverseAlpha + 127) / 255))
    pixels[offset + 2] = UInt8(min(255, Int(pixels[offset + 2]) + (Int(background[2]) * inverseAlpha + 127) / 255))
    pixels[offset + 3] = 255
    if pixels[offset] > 220 && pixels[offset + 1] > 220 && pixels[offset + 2] > 220 {
      let x = Double((offset / 4) % size) - Double(size) / 2
      let y = Double((offset / 4) / size) - Double(size) / 2
      precondition(x * x + y * y <= Double(size * size) * 0.16, "Leaf exceeds maskable safe area")
    }
  }

  guard
    let provider = CGDataProvider(data: Data(pixels) as CFData),
    let flattened = CGImage(
      width: size,
      height: size,
      bitsPerComponent: 8,
      bitsPerPixel: 32,
      bytesPerRow: size * 4,
      space: colorSpace,
      bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
      provider: provider,
      decode: nil,
      shouldInterpolate: false,
      intent: .defaultIntent,
    ),
    let destinationImage = CGImageDestinationCreateWithURL(
      destination as CFURL,
      UTType.png.identifier as CFString,
      1,
      nil,
    )
  else {
    throw NSError(
      domain: "MeterleafIconExport",
      code: 2,
      userInfo: [NSLocalizedDescriptionKey: "Unable to encode \(destination.path)"],
    )
  }

  CGImageDestinationAddImage(destinationImage, flattened, nil)
  guard CGImageDestinationFinalize(destinationImage) else {
    throw NSError(
      domain: "MeterleafIconExport",
      code: 3,
      userInfo: [NSLocalizedDescriptionKey: "Unable to finalize \(destination.path)"],
    )
  }
}

for size in sizes {
  let raster = temporaryDirectory.appendingPathComponent("favicon-\(size).png")
  let output = outputDirectory.appendingPathComponent("meterleaf-leaf-\(size).png")
  try runSips(size: size, output: raster)
  try flatten(source: raster, to: output, size: size)

  if size == 192 || size == 512 {
    let legacy = outputDirectory.appendingPathComponent("meterleaf-\(size).png")
    try? fileManager.removeItem(at: legacy)
    try fileManager.copyItem(at: output, to: legacy)
  }
}

print("Exported Meterleaf PWA icons from \(source.path)")
