import SafariServices
import SwiftUI

struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let configuration = SFSafariViewController.Configuration()
        configuration.barCollapsingEnabled = true
        let controller = SFSafariViewController(url: url, configuration: configuration)
        controller.dismissButtonStyle = .close
        return controller
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

private struct SafariLink: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

private struct InAppSafariModifier: ViewModifier {
    @State private var link: SafariLink?

    func body(content: Content) -> some View {
        content
            .environment(\.openURL, OpenURLAction { url in
                guard url.scheme?.lowercased() == "https" else { return .systemAction }
                link = SafariLink(url: url)
                return .handled
            })
            .sheet(item: $link) { link in
                SafariView(url: link.url).ignoresSafeArea()
            }
    }
}

extension View {
    func inAppSafari() -> some View {
        modifier(InAppSafariModifier())
    }
}
