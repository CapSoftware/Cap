import AVFoundation
import AVKit
import CapKit
import MediaPlayer
import SwiftUI
import UIKit

// MARK: Video surface

final class PlayerLayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

struct PlayerLayerRepresentable: UIViewRepresentable {
    let player: AVPlayer
    let model: CapDetailModel
    var enablesPictureInPicture = false

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> PlayerLayerView {
        let view = PlayerLayerView()
        view.backgroundColor = .black
        // Touches belong to the SwiftUI controls above.
        view.isUserInteractionEnabled = false
        view.playerLayer.player = player
        view.playerLayer.videoGravity = .resizeAspect
        if enablesPictureInPicture, AVPictureInPictureController.isPictureInPictureSupported(),
           let controller = AVPictureInPictureController(playerLayer: view.playerLayer) {
            controller.canStartPictureInPictureAutomaticallyFromInline = true
            controller.delegate = context.coordinator
            context.coordinator.pictureInPicture = controller
            let model = model
            Task { @MainActor in model.pictureInPicture = controller }
        }
        return view
    }

    func updateUIView(_ view: PlayerLayerView, context: Context) {
        if view.playerLayer.player !== player { view.playerLayer.player = player }
    }

    final class Coordinator: NSObject, AVPictureInPictureControllerDelegate {
        let model: CapDetailModel
        var pictureInPicture: AVPictureInPictureController?

        init(model: CapDetailModel) {
            self.model = model
        }

        func pictureInPictureControllerDidStartPictureInPicture(_ controller: AVPictureInPictureController) {
            model.setPictureInPictureActive(true)
        }

        func pictureInPictureControllerDidStopPictureInPicture(_ controller: AVPictureInPictureController) {
            model.setPictureInPictureActive(false)
        }
    }
}

struct RoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView()
        view.tintColor = .white
        view.activeTintColor = UIColor(Color.accentColor)
        view.prioritizesVideoDevices = true
        return view
    }

    func updateUIView(_ view: AVRoutePickerView, context: Context) {}
}

// MARK: Player

struct CapPlayerSurface: View {
    let model: CapDetailModel
    let player: AVPlayer
    var isFullscreen = false

    var body: some View {
        ZStack {
            PlayerLayerRepresentable(player: player, model: model, enablesPictureInPicture: !isFullscreen)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            CaptionOverlay(model: model, raised: isFullscreen && model.controlsVisible)
            BurstLayer(model: model)
            GestureLayer(model: model)
            PlayerControls(model: model, isFullscreen: isFullscreen)
        }
        .background(.black)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Video")
    }
}

private struct GestureLayer: View {
    let model: CapDetailModel
    @State private var skipFeedback: SkipFeedback?

    struct SkipFeedback: Equatable {
        let forward: Bool
        let id = UUID()
    }

    var body: some View {
        GeometryReader { proxy in
            Color.clear
                .contentShape(.rect)
                .onTapGesture(count: 2) { location in
                    let forward = location.x > proxy.size.width / 2
                    model.skip(by: forward ? 10 : -10)
                    skipFeedback = SkipFeedback(forward: forward)
                }
                .onTapGesture { model.toggleControls() }
                .overlay {
                    if let skipFeedback {
                        HStack {
                            if skipFeedback.forward { Spacer() }
                            Label(skipFeedback.forward ? "10 seconds" : "10 seconds", systemImage: skipFeedback.forward ? "goforward.10" : "gobackward.10")
                                .labelStyle(.iconOnly)
                                .font(.title.weight(.semibold))
                                .foregroundStyle(.white)
                                .padding(18)
                                .glassEffect(.regular.tint(.black.opacity(0.2)), in: .circle)
                                .padding(.horizontal, proxy.size.width * 0.12)
                            if !skipFeedback.forward { Spacer() }
                        }
                        .transition(.opacity.combined(with: .scale(scale: 0.8)))
                        .id(skipFeedback.id)
                        .task {
                            try? await Task.sleep(for: .milliseconds(650))
                            withAnimation(.easeOut(duration: 0.2)) { self.skipFeedback = nil }
                        }
                    }
                }
                .animation(.snappy(duration: 0.2), value: skipFeedback)
        }
        .accessibilityHidden(true)
    }
}

private struct PlayerControls: View {
    let model: CapDetailModel
    let isFullscreen: Bool
    @ScaledMetric(relativeTo: .largeTitle) private var playSize: CGFloat = 30
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver

    // VoiceOver users can't tap to reveal controls, so they stay up.
    private var visible: Bool { model.controlsVisible || !model.isPlaying || voiceOver }

    var body: some View {
        ZStack {
            LinearGradient(colors: [.black.opacity(0.45), .clear, .clear, .black.opacity(isFullscreen ? 0.55 : 0.25)], startPoint: .top, endPoint: .bottom)
                .allowsHitTesting(false)

            if model.isBuffering, !model.isScrubbing {
                ProgressView()
                    .controlSize(.large)
                    .tint(.white)
            } else {
                centerControls
            }

            VStack {
                topBar
                Spacer()
                if isFullscreen {
                    PlayerTimeline(model: model, comments: model.detail?.comments ?? [], chapters: model.detail?.chapters ?? [], style: .overlay)
                        .padding(.horizontal, 20)
                        .padding(.bottom, 12)
                }
            }
        }
        .opacity(visible ? 1 : 0)
        .allowsHitTesting(visible)
        .accessibilityHidden(!visible)
        .animation(.easeInOut(duration: 0.2), value: visible)
    }

    private var centerControls: some View {
        GlassEffectContainer(spacing: 28) {
            HStack(spacing: 28) {
                Button { model.skip(by: -10) } label: {
                    Image(systemName: "gobackward.10")
                        .font(.system(size: playSize * 0.62, weight: .semibold))
                        .frame(width: playSize * 1.55, height: playSize * 1.55)
                }
                .accessibilityLabel("Back 10 seconds")

                Button { model.togglePlay() } label: {
                    Image(systemName: model.hasEnded ? "arrow.counterclockwise" : model.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: playSize, weight: .semibold))
                        .contentTransition(.symbolEffect(.replace))
                        .frame(width: playSize * 2.2, height: playSize * 2.2)
                }
                .accessibilityLabel(model.hasEnded ? "Replay" : model.isPlaying ? "Pause" : "Play")

                Button { model.skip(by: 10) } label: {
                    Image(systemName: "goforward.10")
                        .font(.system(size: playSize * 0.62, weight: .semibold))
                        .frame(width: playSize * 1.55, height: playSize * 1.55)
                }
                .accessibilityLabel("Forward 10 seconds")
            }
            .foregroundStyle(.white)
            .buttonStyle(.glass)
            .buttonBorderShape(.circle)
        }
    }

    private var topBar: some View {
        HStack(spacing: 8) {
            if isFullscreen {
                Button { model.isFullscreen = false } label: {
                    Image(systemName: "xmark")
                        .font(.headline)
                        .frame(width: 40, height: 40)
                        .contentShape(.rect)
                }
                .accessibilityLabel("Close full screen")
                if let title = model.cap?.title {
                    Text(title)
                        .font(.headline)
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .shadow(radius: 4)
                }
            }
            Spacer(minLength: 0)
            if model.captionsAvailable {
                Button {
                    model.captionsEnabled.toggle()
                    model.showControls()
                } label: {
                    Image(systemName: model.captionsEnabled ? "captions.bubble.fill" : "captions.bubble")
                        .font(.subheadline.weight(.semibold))
                        .frame(width: 40, height: 40)
                        .contentShape(.rect)
                }
                .accessibilityLabel(model.captionsEnabled ? "Hide captions" : "Show captions")
            }
            Menu {
                Picker("Playback speed", selection: Binding(get: { model.rate }, set: { model.setRate($0) })) {
                    ForEach(CapViewer.playbackSpeeds, id: \.self) { speed in
                        Text(Self.speedName(speed)).tag(speed)
                    }
                }
            } label: {
                Text(Self.speedName(model.rate))
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                    .padding(.horizontal, 10)
                    .frame(minWidth: 40, minHeight: 40)
                    .contentShape(.rect)
            }
            .accessibilityLabel("Playback speed \(Self.speedName(model.rate))")
            RoutePicker()
                .frame(width: 40, height: 40)
                        .contentShape(.rect)
                .accessibilityLabel("AirPlay")
            if !isFullscreen, model.pictureInPicture != nil {
                Button { model.pictureInPicture?.startPictureInPicture() } label: {
                    Image(systemName: "pip.enter")
                        .font(.subheadline.weight(.semibold))
                        .frame(width: 40, height: 40)
                        .contentShape(.rect)
                }
                .accessibilityLabel("Picture in Picture")
            }
            if !isFullscreen {
                Button { model.isFullscreen = true } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.subheadline.weight(.semibold))
                        .frame(width: 40, height: 40)
                        .contentShape(.rect)
                }
                .accessibilityLabel("Full screen")
            }
        }
        .foregroundStyle(.white)
        .buttonStyle(.plain)
        .padding(.horizontal, isFullscreen ? 20 : 8)
        .padding(.top, isFullscreen ? 12 : 6)
    }

    static func speedName(_ rate: Float) -> String {
        rate.formatted(.number.precision(.fractionLength(0...2))) + "×"
    }
}

// MARK: Timeline

struct PlayerTimeline: View {
    enum Style { case inline, overlay }

    let model: CapDetailModel
    let comments: [CapComment]
    let chapters: [Chapter]
    var style: Style = .inline
    var onSelectMarker: (TimelineMarker) -> Void = { _ in }

    @State private var dragging = false

    var body: some View {
        VStack(spacing: style == .inline ? -6 : 2) {
            GeometryReader { proxy in
                let width = proxy.size.width
                ZStack(alignment: .leading) {
                    if style == .inline {
                        MarkerLayer(comments: comments, duration: model.duration ?? 0, width: width) { marker in
                            onSelectMarker(marker)
                        }
                        .offset(y: -9)
                    }
                    ScrubTrack(model: model, chapters: chapters, width: width, dragging: dragging, light: style == .overlay)
                        .offset(y: style == .inline ? 11 : 0)
                }
                .frame(height: proxy.size.height)
                .contentShape(.rect)
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            guard let duration = model.duration, duration > 0, width > 0 else { return }
                            if !dragging {
                                dragging = true
                                model.beginScrub()
                            }
                            model.updateScrub(to: Double(min(max(value.location.x / width, 0), 1)) * duration)
                        }
                        .onEnded { _ in
                            dragging = false
                            model.endScrub()
                        }
                )
                .sensoryFeedback(.selection, trigger: dragging)
            }
            .frame(height: style == .inline ? 52 : 28)

            TimeLabels(model: model, light: style == .overlay)
        }
        .accessibilityElement(children: .contain)
    }
}

private struct ScrubTrack: View {
    let model: CapDetailModel
    let chapters: [Chapter]
    let width: CGFloat
    let dragging: Bool
    let light: Bool

    var body: some View {
        let duration = model.duration ?? 0
        let time = model.scrubTime ?? model.currentTime
        let progress = duration > 0 ? min(max(time / duration, 0), 1) : 0
        let thumb: CGFloat = dragging ? 18 : 12
        ZStack(alignment: .leading) {
            Capsule()
                .fill(light ? AnyShapeStyle(.white.opacity(0.3)) : AnyShapeStyle(.quaternary))
                .frame(height: dragging ? 8 : 5)
            Capsule()
                .fill(Color.accentColor)
                .frame(width: max(5, width * progress), height: dragging ? 8 : 5)
            ForEach(Array(chapters.dropFirst().enumerated()), id: \.offset) { _, chapter in
                if duration > 0, chapter.start > 0, chapter.start < duration {
                    Rectangle()
                        .fill(light ? Color.black.opacity(0.5) : Color(uiColor: .systemBackground))
                        .frame(width: 2, height: dragging ? 8 : 5)
                        .offset(x: width * chapter.start / duration - 1)
                }
            }
            Circle()
                .fill(.white)
                .shadow(color: .black.opacity(0.25), radius: 3, y: 1)
                .overlay(Circle().strokeBorder(Color.accentColor, lineWidth: 2))
                .frame(width: thumb, height: thumb)
                .offset(x: min(max(width * progress - thumb / 2, 0), max(width - thumb, 0)))
            if dragging, let scrub = model.scrubTime {
                let chapter = chapters.last(where: { $0.start <= scrub })?.title
                VStack(spacing: 1) {
                    Text(CapFormat.timestamp(scrub))
                        .font(.subheadline.monospacedDigit().weight(.semibold))
                    if let chapter {
                        Text(chapter)
                            .font(.caption2)
                            .lineLimit(1)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .frame(maxWidth: 180)
                .glassEffect(.regular, in: .capsule)
                .fixedSize()
                .offset(x: min(max(width * progress - 45, 0), max(width - 110, 0)), y: -34)
                .allowsHitTesting(false)
            }
        }
        .animation(.linear(duration: dragging ? 0 : 0.25), value: progress)
        .animation(.snappy(duration: 0.15), value: dragging)
        .accessibilityElement()
        .accessibilityLabel("Playback position")
        .accessibilityValue("\(CapFormat.timestamp(time)) of \(CapFormat.timestamp(duration))")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: model.skip(by: 10)
            case .decrement: model.skip(by: -10)
            @unknown default: break
            }
        }
    }
}

private struct TimeLabels: View {
    let model: CapDetailModel
    let light: Bool

    var body: some View {
        let time = model.scrubTime ?? model.currentTime
        HStack {
            Text(CapFormat.timestamp(time))
            Spacer()
            if let duration = model.duration {
                Text("-" + CapFormat.timestamp(max(0, duration - time)))
            }
        }
        .font(.caption2.monospacedDigit().weight(.medium))
        .foregroundStyle(light ? AnyShapeStyle(.white.opacity(0.85)) : AnyShapeStyle(.secondary))
        .accessibilityHidden(true)
    }
}

// MARK: Fullscreen

struct FullscreenPlayer: View {
    let model: CapDetailModel
    let player: AVPlayer
    @Environment(\.dismiss) private var dismiss
    @State private var dragOffset: CGFloat = 0

    var body: some View {
        CapPlayerSurface(model: model, player: player, isFullscreen: true)
            .ignoresSafeArea()
            .offset(y: dragOffset)
            .gesture(
                DragGesture(minimumDistance: 30)
                    .onChanged { value in dragOffset = max(0, value.translation.height) }
                    .onEnded { value in
                        if value.translation.height > 120 {
                            model.isFullscreen = false
                        } else {
                            withAnimation(.snappy) { dragOffset = 0 }
                        }
                    }
            )
            .statusBarHidden()
            .persistentSystemOverlays(.hidden)
            .onChange(of: model.isFullscreen) { _, value in
                if !value { dismiss() }
            }
            .onAppear {
                model.showControls()
                let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
                AppDelegate.allowLandscape(true, in: scene)
                if model.videoAspect > 1.05 {
                    scene?.requestGeometryUpdate(.iOS(interfaceOrientations: .landscapeRight))
                }
            }
            .onDisappear {
                let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
                AppDelegate.allowLandscape(false, in: scene)
            }
    }
}

// MARK: Overlays

struct CaptionOverlay: View {
    let model: CapDetailModel
    var raised = false

    var body: some View {
        GeometryReader { proxy in
            let video = Self.videoRect(in: proxy.size, aspect: model.videoAspect)
            // Sized to the player rather than the picture, so a portrait video still gets full-width captions.
            let fontSize = min(max(proxy.size.width * 0.04, 15), 24)
            let visible = model.captionsEnabled && model.captionsAvailable && !(model.activeCaption ?? "").isEmpty
            VStack {
                Spacer(minLength: 0)
                if visible, let caption = model.activeCaption {
                    Text(caption)
                        .font(.system(size: fontSize, weight: .medium))
                        .lineSpacing(2)
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                        .padding(.horizontal, fontSize * 0.55)
                        .padding(.vertical, fontSize * 0.25)
                        .background(.black.opacity(0.62), in: .rect(cornerRadius: fontSize * 0.35, style: .continuous))
                        .frame(maxWidth: min(proxy.size.width * 0.92, 620))
                        .transition(.opacity)
                }
            }
            .frame(width: proxy.size.width, height: video.maxY - (raised ? video.height * 0.18 : max(8, video.height * 0.05)))
            .animation(.easeOut(duration: 0.15), value: visible)
            .animation(.easeOut(duration: 0.2), value: raised)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    static func videoRect(in size: CGSize, aspect: Double) -> CGRect {
        guard size.width > 0, size.height > 0, aspect > 0 else { return CGRect(origin: .zero, size: size) }
        if size.width / size.height > aspect {
            let width = size.height * aspect
            return CGRect(x: (size.width - width) / 2, y: 0, width: width, height: size.height)
        }
        let height = size.width / aspect
        return CGRect(x: 0, y: (size.height - height) / 2, width: size.width, height: height)
    }
}

struct BurstLayer: View {
    let model: CapDetailModel

    var body: some View {
        GeometryReader { proxy in
            // Reactions rise inside the picture, not over letterboxing.
            let video = CaptionOverlay.videoRect(in: proxy.size, aspect: model.videoAspect)
            ZStack {
                ForEach(model.bursts) { burst in
                    BurstView(burst: burst, size: video.size) { model.finishBurst(burst) }
                }
            }
            .frame(width: video.width, height: video.height)
            .offset(x: video.minX, y: video.minY)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct BurstView: View {
    let burst: CapDetailModel.ReactionBurst
    let size: CGSize
    let onFinish: () -> Void
    @State private var risen = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Text(burst.emoji)
            .font(.system(size: min(size.height * 0.22, 44)))
            .shadow(color: .black.opacity(0.25), radius: 6, y: 2)
            .scaleEffect(risen ? 1.15 : 0.5)
            .opacity(risen ? 0 : 1)
            .position(x: size.width * burst.lane, y: reduceMotion || !risen ? size.height * 0.78 : size.height * 0.12)
            .task {
                withAnimation(.easeOut(duration: 1.5)) { risen = true }
                try? await Task.sleep(for: .seconds(1.55))
                onFinish()
            }
    }
}

// MARK: Lock screen

@MainActor
final class NowPlaying {
    static let shared = NowPlaying()
    private weak var model: CapDetailModel?
    private var registered = false

    func attach(_ model: CapDetailModel) {
        self.model = model
        registerCommands()
        update(model)
    }

    func update(_ model: CapDetailModel) {
        guard self.model === model else { return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: model.nowPlayingTitle,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: model.currentTime,
            MPNowPlayingInfoPropertyPlaybackRate: model.isPlaying ? Double(model.rate) : 0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: Double(model.rate),
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.video.rawValue,
        ]
        if let artist = model.nowPlayingArtist { info[MPMediaItemPropertyArtist] = artist }
        if let duration = model.duration { info[MPMediaItemPropertyPlaybackDuration] = duration }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func registerCommands() {
        guard !registered else { return }
        registered = true
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated {
                guard let model = self?.model, !model.isPlaying else { return .commandFailed }
                model.togglePlay()
                return .success
            }
        }
        center.pauseCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated {
                guard let model = self?.model, model.isPlaying else { return .commandFailed }
                model.togglePlay()
                return .success
            }
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated {
                guard let model = self?.model else { return .commandFailed }
                model.togglePlay()
                return .success
            }
        }
        center.skipForwardCommand.preferredIntervals = [10]
        center.skipForwardCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated {
                self?.model?.skip(by: 10)
                return .success
            }
        }
        center.skipBackwardCommand.preferredIntervals = [10]
        center.skipBackwardCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated {
                self?.model?.skip(by: -10)
                return .success
            }
        }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            MainActor.assumeIsolated {
                guard let event = event as? MPChangePlaybackPositionCommandEvent, let model = self?.model else { return .commandFailed }
                model.seek(to: event.positionTime, play: model.isPlaying)
                return .success
            }
        }
    }
}
