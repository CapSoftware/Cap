import ActivityKit
import CapKit
import notify
import Observation
import os
import ReplayKit
import SwiftUI
import UIKit
import UserNotifications

enum CaptureMode: String, CaseIterable, Identifiable {
    case instant
    case studio
    case screenshot

    var id: String { rawValue }

    var title: String {
        switch self {
        case .instant: "Instant Mode"
        case .studio: "Studio Mode"
        case .screenshot: "Screenshot Mode"
        }
    }

    var systemImage: String {
        switch self {
        case .instant: "bolt.fill"
        case .studio: "film"
        case .screenshot: "camera.viewfinder"
        }
    }

    var isAvailable: Bool { self == .instant }

    var comingSoonMessage: String { "\(title) is coming soon" }
}

enum RecordMode: String, CaseIterable, Identifiable {
    case camera
    case screen
    case screenAndCamera

    var id: String { rawValue }

    var title: String {
        switch self {
        case .camera: "Camera"
        case .screen: "Screen"
        case .screenAndCamera: "Screen + Camera"
        }
    }

    var recordsScreen: Bool { self != .camera }

    /// Screen + Camera keeps the camera running behind other apps, which needs Apple's multitasking camera
    /// entitlement. It stays hidden until the app has it.
    static let offered: [RecordMode] = [.camera, .screen]
}

/// iOS only lets its own button start a broadcast, so that button sits invisibly on top of Cap's.
@MainActor
@Observable
final class ScreenRecorder {
    static let extensionIdentifier = "so.cap.mobile.broadcast"

    /// True while the screen is being recorded or mirrored.
    private(set) var isCapturing = ScreenRecorder.currentScreen?.isCaptured ?? false

    @ObservationIgnored let picker: RPSystemBroadcastPickerView = {
        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 88, height: 88))
        picker.preferredExtension = ScreenRecorder.extensionIdentifier
        picker.showsMicrophoneButton = true
        return picker
    }()
    @ObservationIgnored private var observer: NSObjectProtocol?

    init() {
        observer = NotificationCenter.default.addObserver(forName: UIScreen.capturedDidChangeNotification, object: nil, queue: .main) { [weak self] note in
            nonisolated(unsafe) let screen = note.object as? UIScreen
            MainActor.assumeIsolated { self?.isCapturing = screen?.isCaptured ?? false }
        }
    }

    private static var currentScreen: UIScreen? {
        UIApplication.shared.connectedScenes.lazy.compactMap { ($0 as? UIWindowScene)?.screen }.first
    }

    static var isScreenCaptured: Bool { currentScreen?.isCaptured ?? false }

    /// Opens the system sheet without a touch, for VoiceOver and other assistive input.
    func showSheet() {
        guard let button = Self.button(in: picker) else { return }
        button.sendActions(for: .touchUpInside)
    }

    static func requestNotifications() {
        Task {
            let center = UNUserNotificationCenter.current()
            guard await center.notificationSettings().authorizationStatus == .notDetermined else { return }
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
        }
    }

    fileprivate static func button(in view: UIView) -> UIButton? {
        for subview in view.subviews {
            if let button = subview as? UIButton { return button }
            if let button = button(in: subview) { return button }
        }
        return nil
    }
}

@MainActor
final class ScreenRecordingSession {
    static let shared = ScreenRecordingSession()

    private static let log = Logger(subsystem: "so.cap.mobile", category: "screen-recording")
    private var activity: Activity<ScreenRecordingAttributes>?
    private var recording: (withCamera: Bool, startedAt: Date, stats: ProcessStats.Mark)?
    private var handOffToken: Int32 = NOTIFY_TOKEN_INVALID
    private var started = false

    func start() {
        guard !started else { return }
        started = true
        activity = Activity<ScreenRecordingAttributes>.activities.first
        let center = NotificationCenter.default
        center.addObserver(forName: UIScreen.capturedDidChangeNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                ScreenRecordingSession.shared.startActivityIfNeeded()
                ScreenRecordingSession.shared.captureChanged()
            }
        }
        center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                ScreenRecordingSession.shared.startActivityIfNeeded()
                ScreenRecordingSession.shared.captureChanged()
            }
        }
        notify_register_dispatch(ScreenRecordingStore.handOffNotification, &handOffToken, .main) { _ in
            Task { await AppServices.shared.screenRecordings?.adopt() }
        }
    }

    func began(withCamera: Bool) {
        guard recording == nil else { return }
        recording = (withCamera, .now, ProcessStats.mark())
        startActivityIfNeeded()
        // iOS only starts Live Activities while Cap is in front, and the system sheet is still
        // closing as recording begins.
        Task {
            for delay in [0.3, 0.5, 1, 1.5, 2, 3] {
                try? await Task.sleep(for: .seconds(delay))
                startActivityIfNeeded()
            }
        }
    }

    private func startActivityIfNeeded() {
        guard let recording, activity?.activityState != .active else { return }
        // Requests only succeed while Cap is on screen; the system sheet over it leaves Cap inactive.
        let state = UIApplication.shared.applicationState
        guard ScreenRecorder.isScreenCaptured, state != .background else {
            ProcessStats.note("Live Activity not started yet: captured \(ScreenRecorder.isScreenCaptured), app state \(state.rawValue)")
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            ProcessStats.note("Live Activities are turned off for Cap")
            return
        }
        do {
            let started = try Activity.request(
                attributes: ScreenRecordingAttributes(startedAt: recording.startedAt, withCamera: recording.withCamera),
                // Ahead of Cap's upload activities in the Dynamic Island.
                content: ActivityContent(state: .init(), staleDate: nil, relevanceScore: 100),
                pushType: nil
            )
            activity = started
            ProcessStats.note("Live Activity started, app state \(state.rawValue)")
        } catch {
            Self.log.error("Screen recording Live Activity didn't start: \(String(describing: error), privacy: .public)")
            ProcessStats.note("Live Activity didn't start: \(error)")
        }
    }

    func stop() {
        guard ScreenRecorder.isScreenCaptured else {
            endActivity()
            return
        }
        RecentRecordings.shared.savingScreen()
        ScreenRecordingStop.request()
        if let found = activity {
            nonisolated(unsafe) let activity = found
            Task { await activity.update(ActivityContent(state: .init(isStopping: true), staleDate: nil, relevanceScore: 100)) }
        }
    }

    private func captureChanged() {
        guard !ScreenRecorder.isScreenCaptured else { return }
        let wasRecording = recording != nil || activity != nil
        endActivity()
        if let recording {
            self.recording = nil
            ProcessStats.measure(since: recording.stats, process: "app", recordedSeconds: Date.now.timeIntervalSince(recording.startedAt), extra: ["bubble": CameraBubble.shared.isFloating ? 1 : 0]).save()
        }
        guard wasRecording else { return }
        ProcessStats.note("Screen recording ended, app state \(UIApplication.shared.applicationState.rawValue)")
        RecentRecordings.shared.savingScreen()
        RecordingCoordinator.shared.showHome()
        Task {
            let notifications = await UNUserNotificationCenter.current().notificationSettings()
            ProcessStats.note("Notifications allowed \(notifications.authorizationStatus.rawValue), alerts \(notifications.alertSetting.rawValue)")
            // The extension hands the recording over, or finishes it itself, within moments.
            for delay in [0.3, 0.7, 1, 2, 4, 8] {
                try? await Task.sleep(for: .seconds(delay))
                await AppServices.shared.screenRecordings?.adopt()
                RecordingCoordinator.shared.collectFinishedScreenRecording(showHome: false)
            }
        }
    }

    private func endActivity() {
        let all = Activity<ScreenRecordingAttributes>.activities
        activity = nil
        for found in all {
            nonisolated(unsafe) let activity = found
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
    }
}

/// Nearly transparent over Cap's record button, so a tap there is a real tap on the system button
/// and the sheet always opens.
struct BroadcastTapTarget: UIViewRepresentable {
    let picker: RPSystemBroadcastPickerView

    func makeUIView(context: Context) -> Container {
        let container = Container()
        container.addSubview(picker)
        return container
    }

    func updateUIView(_ view: Container, context: Context) {}

    final class Container: UIView {
        override func layoutSubviews() {
            super.layoutSubviews()
            guard let picker = subviews.first else { return }
            picker.frame = bounds
            // Hit-testing skips views at or under 1% opacity.
            picker.alpha = 0.02
            if let button = ScreenRecorder.button(in: picker) {
                button.frame = picker.convert(bounds, from: self)
                button.imageView?.alpha = 0
            }
            picker.subviews.forEach { $0.frame = picker.bounds }
        }
    }
}

struct ScreenModePanel: View {
    let recorder: ScreenRecorder
    let mode: RecordMode
    let bubble: CameraBubble
    var compact = false

    var body: some View {
        VStack(spacing: 24) {
            preview
                .accessibilityHidden(true)

            VStack(spacing: 14) {
                Text(recorder.isCapturing ? "Recording your screen" : title)
                    .font(.title2.weight(.semibold))
                if recorder.isCapturing {
                    Text("Use any app. To stop, tap the Dynamic Island or the Stop button on the Lock Screen, or come back here. Cap opens your recording.")
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.7))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                } else if compact {
                    Text("Tap the record button to start another. Stop it from the Dynamic Island.")
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.7))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        step(1, "Tap the record button, then **Start Recording**. Turn the microphone on there to add your voice.")
                        step(2, mode == .screenAndCamera ? "Use any app. Your camera floats on top and is recorded too. Drag it anywhere, pinch to resize, or swipe it to the edge to hide it." : "Use any app. Cap keeps recording.")
                        step(3, "Tap the Dynamic Island to stop. Your link is ready straight away.")
                    }
                }
            }
            .padding(.horizontal, 32)
        }
        .foregroundStyle(.white)
        .onAppear { ScreenRecorder.requestNotifications() }
    }

    private var title: String {
        mode == .screenAndCamera ? "Record your screen and camera" : "Record your screen"
    }

    @ViewBuilder
    private var preview: some View {
        if mode == .screenAndCamera {
            ZStack {
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .fill(.white.opacity(0.08))
                switch bubble.state {
                case .ready:
                    CameraBubbleView(bubble: bubble)
                case .denied:
                    Label("Allow camera access in Settings", systemImage: "camera.fill")
                        .font(.footnote.weight(.semibold))
                        .multilineTextAlignment(.center)
                        .padding()
                case .unavailable:
                    Image(systemName: "video.slash.fill").font(.title)
                case .idle:
                    ProgressView().tint(.white)
                }
            }
            .frame(width: 160, height: 160)
            .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        } else {
            ZStack {
                RoundedRectangle(cornerRadius: 34, style: .continuous)
                    .strokeBorder(.white.opacity(0.35), style: StrokeStyle(lineWidth: 2, dash: [7, 7]))
                    .frame(width: compact ? 72 : 112, height: compact ? 128 : 200)
                Image(systemName: recorder.isCapturing ? "record.circle.fill" : "iphone.gen3")
                    .font(.system(size: 40, weight: .regular))
                    .foregroundStyle(recorder.isCapturing ? .red : .white.opacity(0.85))
                    .symbolEffect(.pulse, isActive: recorder.isCapturing)
            }
        }
    }

    private func step(_ number: Int, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(number)")
                .font(.footnote.weight(.bold).monospacedDigit())
                .frame(width: 22, height: 22)
                .background(Circle().fill(.white.opacity(0.18)))
            Text(text)
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.8))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
