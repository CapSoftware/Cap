import ActivityKit
import CapKit
import SwiftUI
import WidgetKit

struct ScreenRecordingLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ScreenRecordingAttributes.self) { context in
            HStack(spacing: 14) {
                RecordingDot(stopping: context.state.isStopping)
                VStack(alignment: .leading, spacing: 2) {
                    Text(context.state.isStopping ? "Saving your recording" : context.attributes.withCamera ? "Recording screen and camera" : "Recording your screen")
                        .font(.headline)
                        .lineLimit(1)
                    Elapsed(startedAt: context.attributes.startedAt)
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                StopButton(stopping: context.state.isStopping)
            }
            .padding(16)
            .activityBackgroundTint(nil)
            .widgetURL(DeepLink.stopScreenRecordingURL)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 8) {
                        RecordingDot(stopping: context.state.isStopping)
                        Elapsed(startedAt: context.attributes.startedAt)
                            .font(.title3.weight(.semibold).monospacedDigit())
                    }
                    .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    StopButton(stopping: context.state.isStopping)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(context.state.isStopping ? "Saving your recording" : "Tap to stop and open your link")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)
                }
            } compactLeading: {
                // A stop sign, so it doesn't read as iOS's own red recording dot beside it.
                Image(systemName: context.state.isStopping ? "hourglass" : "stop.circle.fill")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(context.state.isStopping ? Color.secondary : Color.red)
                    .accessibilityLabel(context.state.isStopping ? "Saving" : "Stop recording")
            } compactTrailing: {
                Elapsed(startedAt: context.attributes.startedAt)
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .frame(maxWidth: 52)
            } minimal: {
                // Sharing the island with another activity: the time still shows.
                Elapsed(startedAt: context.attributes.startedAt)
                    .font(.system(size: 11, weight: .semibold).monospacedDigit())
                    .foregroundStyle(.red)
                    .minimumScaleFactor(0.6)
                    .frame(maxWidth: 34)
            }
            .widgetURL(DeepLink.stopScreenRecordingURL)
            .keylineTint(.red)
        }
    }
}

private struct Elapsed: View {
    let startedAt: Date

    var body: some View {
        Text(timerInterval: startedAt...startedAt.addingTimeInterval(12 * 60 * 60), countsDown: false)
            .multilineTextAlignment(.center)
    }
}

private struct RecordingDot: View {
    let stopping: Bool

    var body: some View {
        Image(systemName: stopping ? "hourglass" : "record.circle.fill")
            .font(.body.weight(.semibold))
            .foregroundStyle(stopping ? Color.secondary : Color.red)
            .accessibilityLabel(stopping ? "Saving" : "Recording")
    }
}

private struct StopButton: View {
    let stopping: Bool

    var body: some View {
        Link(destination: DeepLink.stopScreenRecordingURL) {
            Label("Stop", systemImage: "stop.fill")
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(Capsule().fill(.red))
                .foregroundStyle(.white)
        }
        .opacity(stopping ? 0.4 : 1)
        .accessibilityLabel("Stop recording")
    }
}
