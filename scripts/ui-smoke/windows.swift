// Prints "x y width height layer name" for each on-screen window whose owner
// name contains the first argument.
import CoreGraphics
import Foundation

let owner = CommandLine.arguments[1]
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for info in list {
    guard let name = info[kCGWindowOwnerName as String] as? String, name.contains(owner),
          let bounds = info[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
    let layer = info[kCGWindowLayer as String] as? Int ?? 0
    let title = info[kCGWindowName as String] as? String ?? ""
    print(Int(bounds["X"]!), Int(bounds["Y"]!), Int(bounds["Width"]!), Int(bounds["Height"]!), layer, title)
}
