// 打包进 Meterleaf.app 的注册助手与后台任务启动器。
//
// 后台任务通过 SMAppService 以包内 plist 注册，系统“登录项与扩展”才会把它显示为
// Meterleaf 并使用应用图标。系统登记时会记下被启动程序的代码签名；临时签名下每次重新
// 构建采集器都会改变签名，登记随之失效。因此 launchd 启动的是这个很少变化的助手，
// 由它 exec 同目录的采集器，采集器升级不影响已有登记。修改本文件会使已有登记失效，
// 系统会拒绝启动，只能换用新的标签重新登记。
//
// 用法:
//   meterleaf-service status|register|unregister <plist 名称>  标准输出只打印一个状态词
//   meterleaf-service exec <参数…>                            以这些参数运行采集器
import Foundation
import ServiceManagement

func fail(_ message: String, _ code: Int32) -> Never {
  FileHandle.standardError.write("\(message)\n".data(using: .utf8)!)
  exit(code)
}

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
guard let action = arguments.first else { fail("缺少操作", 2) }

if action == "exec" {
  let collector = Bundle.main.bundleURL
    .appendingPathComponent("Contents/MacOS/meterleaf-collector").path
  let argv = ["meterleaf-collector"] + arguments.dropFirst()
  var cArgs = argv.map { strdup($0) } + [nil]
  execv(collector, &cArgs)
  fail("无法启动 \(collector): \(String(cString: strerror(errno)))", 1)
}

guard arguments.count == 2 else { fail("用法: meterleaf-service \(action) <plist 名称>", 2) }
let service = SMAppService.agent(plistName: arguments[1])
do {
  switch action {
  case "register": try service.register()
  case "unregister": try service.unregister()
  case "status": break
  default: fail("未知操作: \(action)", 2)
  }
  print(describe(service.status))
} catch {
  FileHandle.standardError.write("\(error.localizedDescription)\n".data(using: .utf8)!)
  print(describe(service.status))
  exit(1)
}
