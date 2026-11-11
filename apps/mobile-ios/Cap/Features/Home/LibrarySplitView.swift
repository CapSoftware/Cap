import CapKit
import SwiftUI

/// A window that is regular in both directions (iPhone Duo open) shows the library beside the open Cap.
/// Anything narrower or shorter, including a phone turned sideways for fullscreen video, keeps the single stack.
enum CapsLayout {
    case stack
    case split

    init(horizontal: UserInterfaceSizeClass?, vertical: UserInterfaceSizeClass?) {
        self = horizontal == .regular && vertical == .regular ? .split : .stack
    }
}

/// The Caps tab's one navigation path, read as library pages, the open Cap, and what was pushed from that Cap.
/// Both layouts read and write the same path, so folding or unfolding keeps the open Cap.
struct CapsPath: Equatable {
    var library: [Route]
    var cap: Route?
    var trailing: [Route]

    init(_ path: [Route]) {
        if let index = path.lastIndex(where: { $0.capID != nil }) {
            library = Array(path[..<index])
            cap = path[index]
            trailing = Array(path[path.index(after: index)...])
        } else {
            library = path
            cap = nil
            trailing = []
        }
    }

    var path: [Route] {
        guard let cap else { return library }
        return library + [cap] + trailing
    }
}

extension Route {
    var capID: CapID? {
        switch self {
        case let .cap(id): id
        case let .share(target): target.id
        default: nil
        }
    }
}

struct CapSelection {
    let selected: CapID?
    let select: (CapID) -> Void
    let deselect: (CapID) -> Void
}

private struct CapSelectionKey: EnvironmentKey {
    static let defaultValue: CapSelection? = nil
}

private struct CapsLayoutKey: EnvironmentKey {
    static let defaultValue = CapsLayout.stack
}

extension EnvironmentValues {
    var capSelection: CapSelection? {
        get { self[CapSelectionKey.self] }
        set { self[CapSelectionKey.self] = newValue }
    }

    var capsLayout: CapsLayout {
        get { self[CapsLayoutKey.self] }
        set { self[CapsLayoutKey.self] = newValue }
    }
}

/// Keeps each open Cap's model, and so its player, alive while the layout around it is rebuilt.
/// Keyed by route, so a link that opens the same Cap at another moment still starts fresh, as it did before.
@MainActor
@Observable
final class CapDetailModels {
    @ObservationIgnored private var models: [Route: CapDetailModel] = [:]
    private var covering: Set<ObjectIdentifier> = []

    var isCovered: Bool { !covering.isEmpty }

    func setCovered(_ covered: Bool, by model: CapDetailModel) {
        let id = ObjectIdentifier(model)
        guard covering.contains(id) != covered else { return }
        if covered { covering.insert(id) } else { covering.remove(id) }
    }

    func model(for route: Route, target: ShareTarget) -> CapDetailModel {
        if let model = models[route] { return model }
        let model = CapDetailModel(target: target)
        models[route] = model
        return model
    }

    func keep(_ path: [Route]) {
        let open = Set(path)
        for (route, model) in models where !open.contains(route) {
            model.discard()
            models[route] = nil
            setCovered(false, by: model)
        }
    }
}

struct LibrarySplitView<Destination: View>: View {
    @Binding var path: [Route]
    @ViewBuilder let destination: (Route) -> Destination

    private var parts: CapsPath { CapsPath(path) }

    var body: some View {
        NavigationSplitView {
            NavigationStack(path: libraryPath) {
                HomeView()
                    .navigationDestination(for: Route.self, destination: destination)
            }
            .navigationSplitViewColumnWidth(min: 300, ideal: 340, max: 380)
            .overlay(alignment: .trailing) {
                Rectangle()
                    .fill(.separator)
                    .frame(width: 1 / 3)
                    .ignoresSafeArea()
            }
        } detail: {
            NavigationStack(path: trailingPath) {
                Group {
                    if let cap = parts.cap {
                        destination(cap)
                            .id(cap)
                    } else {
                        ContentUnavailableView {
                            Label("Pick a Cap", systemImage: "play.rectangle.on.rectangle")
                        } description: {
                            Text("Choose a Cap from your library to watch it here.")
                        }
                    }
                }
                .navigationDestination(for: Route.self, destination: destination)
            }
        }
        .navigationSplitViewStyle(.balanced)
        .environment(\.capSelection, CapSelection(selected: parts.cap?.capID, select: select, deselect: deselect))
    }

    private func select(_ id: CapID) {
        var next = CapsPath(path)
        guard next.cap?.capID != id || !next.trailing.isEmpty else { return }
        next.cap = .cap(id)
        next.trailing = []
        path = next.path
    }

    private func deselect(_ id: CapID) {
        var next = CapsPath(path)
        guard next.cap?.capID == id else { return }
        next.cap = nil
        next.trailing = []
        path = next.path
    }

    private var libraryPath: Binding<[Route]> {
        Binding {
            CapsPath(path).library
        } set: { library in
            var next = CapsPath(path)
            next.library = library
            path = next.path
        }
    }

    private var trailingPath: Binding<[Route]> {
        Binding {
            CapsPath(path).trailing
        } set: { trailing in
            var next = CapsPath(path)
            next.trailing = trailing
            path = next.path
        }
    }
}

struct CapRow: View {
    let cap: CapSummary
    let isSelected: Bool
    @Environment(SessionModel.self) private var session

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            CapThumbnail(cap: cap, cornerRadius: 10, showsBadges: false)
                .frame(width: 116)
                .overlay(alignment: .bottomTrailing) {
                    if let duration = CapFormat.duration(cap.durationSeconds), !cap.isProcessing {
                        Text(duration)
                            .font(.caption2.weight(.semibold).monospacedDigit())
                            .foregroundStyle(.white)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .background(.black.opacity(0.55), in: .capsule)
                            .padding(5)
                            .accessibilityLabel("Duration \(duration)")
                    }
                }
            VStack(alignment: .leading, spacing: 4) {
                Text(cap.title.isEmpty ? "Untitled" : cap.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .foregroundStyle(.primary)
                HStack(spacing: 4) {
                    if !cap.isOwned(by: session.credentials.userId), !cap.ownerName.isEmpty {
                        Text(cap.ownerName)
                        Text("·")
                    }
                    Text(CapFormat.relative(cap.createdAt))
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                HStack(spacing: 10) {
                    if cap.isOwned(by: session.credentials.userId) {
                        StatLabel(value: cap.viewCount, systemImage: "eye", accessibilityNoun: "views")
                    }
                    if cap.commentCount > 0 {
                        StatLabel(value: cap.commentCount, systemImage: "bubble.left", accessibilityNoun: "comments")
                    }
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(8)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(isSelected ? Color.accentColor.opacity(0.14) : .clear)
        }
        .contentShape(.rect(cornerRadius: 16))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityHint("Opens this Cap")
    }
}
