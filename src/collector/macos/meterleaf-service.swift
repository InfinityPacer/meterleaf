// 打包进 Meterleaf.app 的注册助手。后台任务通过 SMAppService 以包内 plist 注册，
// 系统“登录项与扩展”才会把它显示为 Meterleaf 并使用应用图标。
// 用法: meterleaf-service <plist 名称> [register|unregister]；标准输出只打印一个状态词。
import Foundation
import ServiceManagement

func describe(_ status: SMAppService.Status) -> String {
  switch status {
  case .notRegistered: return "not-registered"
  case .enabled: return "enabled"
  case .requiresApproval: return "requires-approval"
  case .notFound: return "not-found"
  @unknown default: return "unknown"
  }
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard let plistName = arguments.first else {
  FileHandle.standardError.write("缺少 plist 名称\n".data(using: .utf8)!)
  exit(2)
}
let service = SMAppService.agent(plistName: plistName)
do {
  switch arguments.dropFirst().first {
  case "register": try service.register()
  case "unregister": try service.unregister()
  case nil, "status": break
  case let other?:
    FileHandle.standardError.write("未知操作: \(other)\n".data(using: .utf8)!)
    exit(2)
  }
  print(describe(service.status))
} catch {
  FileHandle.standardError.write("\(error.localizedDescription)\n".data(using: .utf8)!)
  print(describe(service.status))
  exit(1)
}
