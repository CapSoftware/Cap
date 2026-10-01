// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

import Foundation
import SafariServices
import SwiftRs
import Tauri
import UIKit
import WebKit

struct OpenArgs: Decodable {
  let url: String
  let with: String?
}

class OpenerPlugin: Plugin {
  @objc public func open(_ invoke: Invoke) throws {
    do {
      let args = try invoke.parseArgs(OpenArgs.self)
      if let url = URL(string: args.url) {
        if args.with == "inAppBrowser" {
          DispatchQueue.main.async {
            let safariVC = SFSafariViewController(url: url)
            self.manager.viewController?.present(safariVC, animated: true)
          }
        } else {
          if #available(iOS 10, *) {
            UIApplication.shared.open(url, options: [:])
          } else {
            UIApplication.shared.openURL(url)
          }
        }

      }
      invoke.resolve()
    } catch {
      invoke.reject(error.localizedDescription)
    }
  }
}

@_cdecl("init_plugin_opener")
func initPlugin() -> Plugin {
  return OpenerPlugin()
}
