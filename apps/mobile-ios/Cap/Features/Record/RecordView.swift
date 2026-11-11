@preconcurrency import AVFoundation
import CapKit
import SwiftUI
import UIKit

struct RecordView: View {
    @State private var model: RecordModel
    @State private var confirmingDiscard = false
    @State private var screen = ScreenRecorder()
    private let bubble = CameraBubble.shared
    private let recent = RecentRecordings.shared
    @AppStorage("so.cap.mobile.recordMode") private var mode: RecordMode = .camera
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    private let upgrade = WebUpgrade.shared

    init(session: SessionModel, folderId: String?) {
        _model = State(initialValue: RecordModel(session: session, folderId: folderId))
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if mode == .camera {
                CameraPreview(session: model.capture.session, position: model.position, isLive: model.phase == .ready)
                    .ignoresSafeArea()
                    .opacity(model.phase == .ready || model.isRecording || model.phase == .finishing ? 1 : 0)
                    .animation(.easeOut(duration: 0.25), value: model.phase)

                switch model.phase {
                case .cameraDenied:
                    blocked(
                        title: "Cap needs your camera",
                        message: "Allow camera access in Settings to record. Microphone access adds your voice.",
                        systemImage: "camera.fill",
                        action: ("Open Settings", openSettings)
                    )
                case let .unavailable(message):
                    blocked(title: "Camera unavailable", message: message, systemImage: "video.slash.fill", action: nil)
                case .preparing:
                    ProgressView().tint(.white)
                default:
                    EmptyView()
                }
            }

            controls
        }
        .preferredColorScheme(.dark)
        .persistentSystemOverlays(model.isRecording ? .hidden : .automatic)
        .task { upgrade.start() }
        .onAppear {
            if !RecordMode.offered.contains(mode) { mode = .screen }
        }
        .task(id: mode) {
            // Each camera only runs while it's being shown.
            switch mode {
            case .camera:
                bubble.releaseUnlessFloating()
                await model.prepare()
            case .screen:
                model.pauseCamera()
                bubble.releaseUnlessFloating()
            case .screenAndCamera:
                model.pauseCamera()
                await bubble.prepare()
            }
        }
        .onChange(of: screen.isCapturing) { _, capturing in
            guard capturing, mode.recordsScreen else { return }
            ScreenRecordingSession.shared.began(withCamera: mode == .screenAndCamera)
            if mode == .screenAndCamera { bubble.float() }
        }
        .onAppear { recent.isRecorderVisible = true }
        .onDisappear {
            recent.isRecorderVisible = false
            model.teardown()
            bubble.releaseUnlessFloating()
        }
        .onChange(of: scenePhase) { _, phase in
            // Coming back from Settings after granting access.
            if phase == .active, model.phase == .cameraDenied { Task { await model.prepare() } }
        }
        .confirmationDialog("Discard this recording?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) {
                model.discard()
                dismiss()
            }
            Button("Keep recording", role: .cancel) {}
        } message: {
            Text("It will be deleted and its link will stop working.")
        }
    }

    private var controls: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center) {
                Button {
                    if model.isRecording { confirmingDiscard = true } else { dismiss() }
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(width: 44, height: 44)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: Circle())
                .accessibilityLabel(model.isRecording ? "Discard recording" : "Close")
                .disabled(model.phase == .finishing)

                Spacer()

                if case let .recording(startedAt) = model.phase {
                    RecordingTimer(startedAt: startedAt, limit: model.limit)
                        .transition(.scale(scale: 0.8).combined(with: .opacity))
                } else if !screen.isCapturing, model.phase != .finishing {
                    CaptureModeSwitch()
                        .transition(.opacity)
                }

                Spacer()

                Color.clear.frame(width: 44, height: 44)
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)

            if !model.isRecording, !screen.isCapturing, !recent.items.isEmpty {
                RecentRecordingsList(recent: recent)
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }

            Spacer(minLength: 12)

            if mode.recordsScreen {
                // In the same column as the list above, so the two never overlap.
                ScreenModePanel(recorder: screen, mode: mode, bubble: bubble, compact: !recent.items.isEmpty)
                    .transition(.opacity)
                Spacer(minLength: 12)
            }

            if model.limit != nil, !model.isRecording, !screen.isCapturing, model.phase != .finishing {
                FreeLimitNote(upgradeURL: upgrade.isAllowed ? model.upgradeURL : nil)
                    .padding(.horizontal, 32)
                    .padding(.bottom, 14)
                    .transition(.opacity)
            }

            if !model.isRecording, model.phase != .finishing {
                ModePicker(mode: $mode)
                    .padding(.bottom, 20)
                    .transition(.opacity)
            }

            if mode == .camera, !model.hasMicrophone, model.phase == .ready {
                Button(action: openSettings) {
                    Label("Microphone off", systemImage: "mic.slash.fill")
                        .font(.footnote.weight(.semibold))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: Capsule())
                .padding(.bottom, 18)
                .accessibilityHint("Opens Settings to allow microphone access")
            }

            HStack {
                Color.clear.frame(width: 52, height: 52)
                Spacer()
                if mode == .camera {
                    RecordButton(isRecording: model.isRecording, isBusy: model.phase == .finishing) {
                        if model.isRecording {
                            Task { await model.stop() }
                        } else {
                            model.record()
                        }
                    }
                    .disabled(!(model.phase == .ready || model.isRecording))
                } else {
                    RecordButton(isRecording: screen.isCapturing, isBusy: false, label: screen.isCapturing ? "Stop screen recording" : "Start screen recording") {
                        if screen.isCapturing { ScreenRecordingSession.shared.stop() } else { screen.showSheet() }
                    }
                    // Starting needs the system's own button, so touches land on it; VoiceOver uses the action above.
                    .overlay {
                        if !screen.isCapturing {
                            BroadcastTapTarget(picker: screen.picker)
                                .accessibilityHidden(true)
                        }
                    }
                }
                Spacer()
                Button(action: model.flip) {
                    Image(systemName: "arrow.triangle.2.circlepath.camera")
                        .font(.system(size: 19, weight: .semibold))
                        .frame(width: 52, height: 52)
                        .contentShape(Circle())
                        .rotation3DEffect(.degrees(model.position == .back ? 180 : 0), axis: (x: 0, y: 1, z: 0))
                        .animation(.spring(duration: 0.4), value: model.position)
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: Circle())
                .disabled(model.isFlipping || !(model.phase == .ready || model.isRecording))
                .opacity(mode == .camera ? 1 : 0)
                .accessibilityHidden(mode != .camera)
                .accessibilityLabel(model.position == .front ? "Switch to back camera" : "Switch to front camera")
            }
            .padding(.horizontal, 36)
            .padding(.bottom, 24)
        }
        .foregroundStyle(.white)
        .animation(.spring(duration: 0.35), value: model.isRecording)
        .animation(.spring(duration: 0.35), value: mode)
        .animation(.spring(duration: 0.35), value: recent.items)
    }

    private func blocked(title: String, message: String, systemImage: String, action: (String, () -> Void)?) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(message)
        } actions: {
            if let action {
                Button(action.0, action: action.1)
                    .buttonStyle(.glassProminent)
            }
        }
        .foregroundStyle(.white)
    }

    private func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
    }
}

private struct CaptureModeSwitch: View {
    @State private var comingSoon: CaptureMode?
    @State private var taps = 0

    var body: some View {
        HStack(spacing: 2) {
            ForEach(CaptureMode.allCases) { option in
                if option.isAvailable {
                    Label(option.title, systemImage: option.systemImage)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                        .padding(.horizontal, 12)
                        .frame(height: 36)
                        .background(Capsule().fill(.white.opacity(0.22)))
                        .accessibilityElement(children: .combine)
                        .accessibilityAddTraits(.isSelected)
                } else {
                    Button {
                        comingSoon = option
                        taps += 1
                        AccessibilityNotification.Announcement(option.comingSoonMessage).post()
                    } label: {
                        Image(systemName: option.systemImage)
                            .font(.system(size: 15, weight: .semibold))
                            .frame(width: 40, height: 36)
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.white.opacity(0.55))
                    .accessibilityLabel(option.title)
                    .accessibilityValue("Coming soon")
                }
            }
        }
        .opacity(comingSoon == nil ? 1 : 0)
        .allowsHitTesting(comingSoon == nil)
        .accessibilityHidden(comingSoon != nil)
        .overlay {
            if let comingSoon {
                Text(comingSoon.comingSoonMessage)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .padding(.horizontal, 8)
                    .transition(.opacity)
            }
        }
        .padding(4)
        .glassEffect(.regular, in: Capsule())
        .dynamicTypeSize(...DynamicTypeSize.large)
        .animation(.easeOut(duration: 0.2), value: comingSoon)
        .sensoryFeedback(.selection, trigger: taps)
        .task(id: taps) {
            guard comingSoon != nil else { return }
            try? await Task.sleep(for: .seconds(2.4))
            guard !Task.isCancelled else { return }
            comingSoon = nil
        }
    }
}

private struct ModePicker: View {
    @Binding var mode: RecordMode

    var body: some View {
        HStack(spacing: 4) {
            ForEach(RecordMode.offered) { option in
                Button {
                    mode = option
                } label: {
                    Text(option.title)
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 16)
                        .frame(height: 34)
                        .background {
                            if mode == option {
                                Capsule().fill(.white.opacity(0.22))
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(mode == option ? .isSelected : [])
            }
        }
        .padding(4)
        .glassEffect(.regular, in: Capsule())
        .sensoryFeedback(.selection, trigger: mode)
    }
}

/// Outside the United States storefront App Review allows no way to buy outside the App Store, so the
/// note only states the limit; on that storefront it links to the dashboard (see `WebUpgrade`).
private struct FreeLimitNote: View {
    let upgradeURL: URL?

    var body: some View {
        VStack(spacing: 6) {
            Text("Free plan recordings stop at 5 minutes.\nCap Pro has no limit.")
                .accessibilityLabel("Free plan recordings stop at 5 minutes. Cap Pro has no limit.")
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.75))
                .multilineTextAlignment(.center)
            if let upgradeURL {
                Button {
                    UIApplication.shared.open(upgradeURL)
                } label: {
                    Label("Upgrade in your Cap dashboard", systemImage: "arrow.up.forward")
                        .font(.footnote.weight(.semibold))
                        .labelStyle(TrailingIconLabelStyle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens your Cap dashboard in Safari")
            }
        }
        .shadow(color: .black.opacity(0.5), radius: 6)
    }
}

private struct TrailingIconLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.title
            configuration.icon.imageScale(.small)
        }
    }
}

/// Drawn by the system's timer text so it ticks without re-rendering the screen.
private struct RecordingTimer: View {
    let startedAt: Date
    let limit: TimeInterval?

    var body: some View {
        if let limit {
            let warnAt = startedAt.addingTimeInterval(max(0, limit - 30))
            TimelineView(.explicit([warnAt])) { context in
                let warning = context.date >= warnAt
                timer(warning: warning)
                    .sensoryFeedback(.warning, trigger: warning) { _, now in now }
            }
        } else {
            timer(warning: false)
        }
    }

    private func timer(warning: Bool) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(.red)
                .frame(width: 8, height: 8)
                .phaseAnimator([1.0, 0.35]) { dot, opacity in
                    dot.opacity(opacity)
                } animation: { _ in .easeInOut(duration: 0.8) }
            Text(timerInterval: startedAt...startedAt.addingTimeInterval(limit ?? 12 * 60 * 60), countsDown: false)
                .font(.subheadline.monospacedDigit().weight(.semibold))
                .foregroundStyle(warning ? Color.orange : Color.white)
            if let limit {
                Text("/ \(CapFormat.duration(limit) ?? "5:00")")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.white.opacity(0.6))
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 36)
        .glassEffect(.regular, in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Recording")
    }
}

private struct RecordButton: View {
    let isRecording: Bool
    let isBusy: Bool
    var label: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .strokeBorder(.white, lineWidth: 5)
                    .frame(width: 80, height: 80)
                RoundedRectangle(cornerRadius: isRecording ? 8 : 32, style: .continuous)
                    .fill(Color(red: 1, green: 0.23, blue: 0.19))
                    .frame(width: isRecording ? 32 : 64, height: isRecording ? 32 : 64)
                if isBusy {
                    ProgressView().tint(.white)
                }
            }
            .frame(width: 88, height: 88)
            .contentShape(Circle())
        }
        .buttonStyle(RecordPressStyle())
        .animation(.spring(duration: 0.3, bounce: 0.2), value: isRecording)
        .sensoryFeedback(.impact(weight: .medium), trigger: isRecording)
        .accessibilityLabel(label ?? (isRecording ? "Stop recording" : "Start recording"))
    }
}

private struct RecordPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.92 : 1)
            .animation(.spring(duration: 0.2), value: configuration.isPressed)
    }
}

private struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession
    /// Switching cameras or restarting the camera gives the layer a new connection, which then needs turning upright again.
    let position: AVCaptureDevice.Position
    let isLive: Bool

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        NotificationCenter.default.addObserver(view, selector: #selector(PreviewView.sessionStarted), name: AVCaptureSession.didStartRunningNotification, object: session)
        return view
    }

    func updateUIView(_ view: PreviewView, context: Context) {
        view.keepUpright()
    }

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        override func layoutSubviews() {
            super.layoutSubviews()
            keepUpright()
        }

        @objc nonisolated func sessionStarted() {
            Task { @MainActor in keepUpright() }
        }

        func keepUpright() {
            guard let connection = previewLayer.connection, connection.videoRotationAngle != 90, connection.isVideoRotationAngleSupported(90) else { return }
            connection.videoRotationAngle = 90
        }
    }
}

