import SwiftUI
import UIKit

/// What each recording stopped this session is doing, so the next one can start straight away.
/// Shown on the record screen and above the library.
struct RecentRecordingsList: View {
    let recent: RecentRecordings
    var items: [RecentRecordings.Item]? = nil

    var body: some View {
        GlassEffectContainer(spacing: 8) {
            VStack(spacing: 8) {
                ForEach((items ?? recent.items).prefix(3)) { item in
                    Row(item: item, recent: recent)
                }
            }
        }
    }

    private struct Row: View {
        let item: RecentRecordings.Item
        let recent: RecentRecordings

        var body: some View {
            HStack(spacing: 12) {
                status
                    .frame(width: 30, height: 30)
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.kind == .screen ? "Screen recording" : "Camera recording")
                        .font(.subheadline.weight(.semibold))
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .contentTransition(.numericText())
                }
                Spacer(minLength: 8)
                if item.shareUrl != nil {
                    Button {
                        recent.copyLink(item)
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    } label: {
                        Image(systemName: item.linkCopied ? "checkmark" : "link")
                            .font(.system(size: 15, weight: .semibold))
                            .contentTransition(.symbolEffect(.replace))
                            .frame(width: 36, height: 36)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(item.linkCopied ? "Link copied" : "Copy link")
                }
                if case .failed = item.status {
                    Button {
                        recent.dismiss(item)
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 13, weight: .semibold))
                            .frame(width: 36, height: 36)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss")
                }
            }
            .padding(.leading, 12)
            .padding(.trailing, 6)
            .frame(height: 52)
            .contentShape(Capsule())
            .onTapGesture(perform: open)
            .glassEffect(.regular.interactive(), in: Capsule())
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(item.capId != nil ? .isButton : [])
            .accessibilityHint(item.capId != nil ? "Opens the recording" : "")
        }

        @ViewBuilder
        private var status: some View {
            switch item.status {
            case .saving:
                ProgressView()
            case let .uploading(fraction):
                ZStack {
                    Circle().stroke(.tertiary, lineWidth: 3)
                    Circle()
                        .trim(from: 0, to: max(0.04, fraction))
                        .stroke(.foreground, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .animation(.easeOut(duration: 0.3), value: fraction)
                }
                .padding(3)
            case .ready:
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 24))
                    .foregroundStyle(.green)
            case .failed:
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(.orange)
            }
        }

        private var detail: String {
            switch item.status {
            case .saving:
                return "Saving"
            case let .uploading(fraction):
                let percent = "Uploading \(Int((fraction * 100).rounded()))%"
                return item.linkCopied ? percent + " · Link copied" : percent
            case .ready:
                return item.linkCopied ? "Ready · Link copied" : "Ready to share"
            case let .failed(message):
                return message
            }
        }

        private func open() {
            guard let capId = item.capId else { return }
            NotificationCenter.default.post(name: .capOpenCap, object: capId)
        }
    }
}
