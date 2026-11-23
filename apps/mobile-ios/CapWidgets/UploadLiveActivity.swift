import ActivityKit
import CapKit
import SwiftUI
import WidgetKit

struct UploadLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: CapUploadAttributes.self) { context in
            LockScreenUploadView(context: context)
                .activityBackgroundTint(nil)
                .widgetURL(context.state.deepLink)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image("CapLogo")
                        .resizable()
                        .frame(width: 36, height: 36)
                        .padding(.leading, 4)
                        .accessibilityLabel("Cap")
                }
                DynamicIslandExpandedRegion(.trailing) {
                    StatusBadge(context: context)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.attributes.title)
                        .font(.headline)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        UploadProgressBar(context: context)
                        Text(UploadCopy.status(context))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                Image("CapLogo")
                    .resizable()
                    .frame(width: 22, height: 22)
                    .accessibilityLabel("Cap")
            } compactTrailing: {
                CompactProgress(context: context)
            } minimal: {
                CompactProgress(context: context)
            }
            .widgetURL(context.state.deepLink)
            .keylineTint(Color("CapBlue"))
        }
    }
}

enum UploadCopy {
    static func verb(_ kind: CapUploadAttributes.Kind) -> String {
        switch kind {
        case .video: "Uploading"
        case .image: "Uploading photo"
        case .loom: "Importing from Loom"
        case .recording: "Uploading recording"
        }
    }

    static func status(_ context: ActivityViewContext<CapUploadAttributes>) -> String {
        let state = context.state
        switch state.phase {
        case .preparing:
            return "Getting ready"
        case .uploading, .importing:
            // Updates pause while Cap is suspended; the transfer itself carries on.
            if context.isStale { return "\(verb(context.attributes.kind)) in the background" }
            return "\(verb(context.attributes.kind)) · \(Int((state.fraction * 100).rounded()))%"
        case .finishing:
            return "Finishing up"
        case .done:
            return "Ready to share"
        case .failed:
            return state.message ?? "Upload failed"
        }
    }
}

private struct StatusBadge: View {
    let context: ActivityViewContext<CapUploadAttributes>

    var body: some View {
        switch context.state.phase {
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .font(.title2)
                .foregroundStyle(.green)
                .accessibilityLabel("Done")
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.title2)
                .foregroundStyle(.orange)
                .accessibilityLabel("Failed")
        default:
            Text("\(Int((context.state.fraction * 100).rounded()))%")
                .font(.title3.weight(.semibold).monospacedDigit())
                .foregroundStyle(Color("CapBlue"))
                .contentTransition(.numericText())
        }
    }
}

private struct UploadProgressBar: View {
    let context: ActivityViewContext<CapUploadAttributes>

    var body: some View {
        switch context.state.phase {
        case .done:
            ProgressView(value: 1).tint(.green)
        case .failed:
            ProgressView(value: 0).tint(.orange)
        case .preparing, .finishing:
            ProgressView().progressViewStyle(.linear).tint(Color("CapBlue"))
        case .uploading, .importing:
            ProgressView(value: context.state.fraction).tint(Color("CapBlue"))
        }
    }
}

private struct CompactProgress: View {
    let context: ActivityViewContext<CapUploadAttributes>

    var body: some View {
        switch context.state.phase {
        case .done:
            Image(systemName: "checkmark")
                .font(.caption.weight(.bold))
                .foregroundStyle(.green)
                .accessibilityLabel("Done")
        case .failed:
            Image(systemName: "exclamationmark")
                .font(.caption.weight(.bold))
                .foregroundStyle(.orange)
                .accessibilityLabel("Failed")
        default:
            ProgressView(value: context.state.phase == .finishing ? 1 : context.state.fraction)
                .progressViewStyle(.circular)
                .tint(Color("CapBlue"))
                .frame(width: 20, height: 20)
                .accessibilityLabel("\(Int((context.state.fraction * 100).rounded())) percent")
        }
    }
}

private struct LockScreenUploadView: View {
    let context: ActivityViewContext<CapUploadAttributes>

    var body: some View {
        HStack(spacing: 14) {
            Image("CapLogo")
                .resizable()
                .frame(width: 44, height: 44)
                .accessibilityLabel("Cap")
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(context.attributes.title)
                        .font(.headline)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    StatusBadge(context: context)
                        .font(.subheadline)
                }
                UploadProgressBar(context: context)
                Text(UploadCopy.status(context))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(16)
    }
}
