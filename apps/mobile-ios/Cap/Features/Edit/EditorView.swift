import AVFoundation
import CapKit
import SwiftUI
import UIKit

struct EditorView: View {
    @State var model: EditorModel
    let onFinished: (EditorOutcome) -> Void

    @State private var confirmingDiscard = false
    @State private var confirmingRestore = false
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    enum EditorOutcome { case cancelled, saved, restored }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                switch model.phase {
                case .loading:
                    ProgressView().tint(.white)
                case let .failed(message):
                    ContentUnavailableView {
                        Label("Couldn't open the editor", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Try again") { Task { await model.load() } }
                            .buttonStyle(.glassProminent)
                    }
                case .ready:
                    content
                }
            }
            .navigationTitle("Edit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        if model.hasChanges { confirmingDiscard = true } else { finish(.cancelled) }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { if await model.save() { finish(.saved) } }
                    } label: {
                        if model.isSaving { ProgressView() } else { Text("Save") }
                    }
                    .disabled(!model.hasChanges || model.isSaving)
                }
            }
        }
        .preferredColorScheme(.dark)
        .task {
            #if DEBUG
            if EditorDebug.runsScript {
                async let loading: Void = model.load()
                await model.runScript { finish(.cancelled) }
                await loading
                return
            }
            #endif
            await model.load()
        }
        .onDisappear { model.close() }
        .confirmationDialog("Discard your changes?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
            Button("Discard changes", role: .destructive) { finish(.cancelled) }
            Button("Keep editing", role: .cancel) {}
        }
        .confirmationDialog("Restore the original video?", isPresented: $confirmingRestore, titleVisibility: .visible) {
            Button("Restore original", role: .destructive) {
                Task { if await model.restoreOriginal() { finish(.restored) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Every edit made to this Cap is undone. Comments stay where they are.")
        }
        .alert("Couldn't save the edit", isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "")
        }
        .interactiveDismissDisabled(model.hasChanges)
    }

    private func finish(_ outcome: EditorOutcome) {
        model.close()
        onFinished(outcome)
    }

    private var content: some View {
        VStack(spacing: 18) {
            ZStack {
                ForEach(model.players.indices, id: \.self) { index in
                    EditorPlayerSurface(player: model.players[index]) { model.metrics.mark("firstFrame") }
                        .zIndex(index == model.activePlayer ? 1 : 0)
                }
                EditorPlayerSurface(player: model.sourcePlayer)
                    .zIndex(model.showsSource ? 2 : -1)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityHidden(true)

            Text("\(CapFormat.timestamp(model.outputTime)) / \(CapFormat.timestamp(model.displayedTimeline.outputDuration))")
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(.secondary)
                .accessibilityLabel("Edited length \(CapFormat.timestamp(model.displayedTimeline.outputDuration))")
                .opacity(model.isTrimming ? 0 : 1)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.horizontal, 16)

            if wide {
                HStack(spacing: 10) {
                    historyTools
                    EditorTimeline(model: model)
                        .padding(.horizontal, 6)
                    clipTools
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            } else {
                EditorTimeline(model: model)
                    .padding(.horizontal, 15)

                HStack(spacing: 10) {
                    historyTools
                    Spacer()
                    clipTools
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            }
        }
        .sensoryFeedback(.impact(weight: .medium), trigger: model.timeline.clips.count)
    }

    private var wide: Bool {
        horizontalSizeClass == .regular && verticalSizeClass == .regular
    }

    @ViewBuilder
    private var historyTools: some View {
        toolButton("Undo", systemImage: "arrow.uturn.backward", enabled: model.canUndo, action: model.undo)
        toolButton("Redo", systemImage: "arrow.uturn.forward", enabled: model.canRedo, action: model.redo)
    }

    @ViewBuilder
    private var clipTools: some View {
        if model.state.hasEdits {
            toolButton("Restore original", systemImage: "clock.arrow.circlepath", enabled: !model.isSaving) {
                confirmingRestore = true
            }
        }
        toolButton("Split", systemImage: "scissors", enabled: model.canSplit, action: model.split)
        toolButton("Delete", systemImage: "trash", enabled: model.canDelete, action: model.deleteSelected)
    }

    private func toolButton(_ title: String, systemImage: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 18, weight: .semibold))
                .frame(width: 48, height: 48)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: Circle())
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.35)
        .accessibilityLabel(title)
    }
}

/// Sizes, colours and touch behaviour follow the Photos video trimmer: the strip is the whole video and never moves,
/// cut video stays in place dimmed, and a handle shows the frame it is on while it is dragged.
private struct EditorTimeline: View {
    let model: EditorModel

    static let height: CGFloat = 51
    private static let border: CGFloat = 5
    private static let handle = CGFloat(TrimTrack.handleWidth)
    private static let corner: CGFloat = 4.5
    private static let accent = Color(red: 1, green: 0.8, blue: 0)
    private static let chrome = Color(red: 108 / 255, green: 108 / 255, blue: 111 / 255)

    private enum Drag: Equatable {
        case scrub
        case trim(clip: Int, edge: TrimEdge)
        /// Went down outside the strip. SwiftUI lets a drag begin a little outside the view; Photos does not.
        case ignored
    }

    @State private var drag: Drag?
    @State private var zoom: TrimTrack.Zoom?
    @State private var holdTask: Task<Void, Never>?
    @GestureState private var touching = false

    var body: some View {
        HStack(spacing: 1) {
            Button(action: model.togglePlay) {
                Image(systemName: model.isPlaying ? "pause.fill" : "play.fill")
                    .font(.system(size: 24))
                    .foregroundStyle(.white)
                    .frame(width: 47, height: Self.height)
                    .background(Self.chrome, in: UnevenRoundedRectangle(topLeadingRadius: Self.corner, bottomLeadingRadius: Self.corner))
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(model.isPlaying ? "Pause" : "Play")

            GeometryReader { proxy in
                strip(width: proxy.size.width)
            }
            .frame(height: Self.height)
        }
    }

    private func strip(width: CGFloat) -> some View {
        let shown = model.displayedTimeline
        let track = TrimTrack(duration: shown.sourceDuration, width: Double(width - 2 * Self.handle), zoom: zoom)
        let active = model.activeClip.flatMap { shown.clips.indices.contains($0) ? $0 : nil }
        return ZStack(alignment: .topLeading) {
            Self.chrome

            film(track: track, timeline: shown, width: width)
                .offset(y: Self.border)

            if let active {
                frame(for: shown.clips[active], whole: shown.isUnchanged, track: track)
            }

            if let located = shown.locate(output: model.outputTime) {
                let centre = track.playheadPosition(for: model.playheadSource, in: shown.clips[located.index])
                Capsule()
                    .fill(.white)
                    .frame(width: CGFloat(TrimTrack.playheadWidth), height: Self.height - 6.67)
                    .shadow(color: .black.opacity(0.45), radius: 1)
                    .offset(x: Self.handle + CGFloat(centre - TrimTrack.playheadWidth / 2), y: 3.33)
                    .opacity(model.isTrimming ? 0 : 1)
                    .accessibilityElement()
                    .accessibilityLabel("Playhead")
                    .accessibilityValue(Self.seconds(model.playheadSource))
            }

            accessibilityMarks(timeline: shown, active: active, track: track, width: width)
        }
        .frame(width: width, height: Self.height, alignment: .topLeading)
        .clipShape(UnevenRoundedRectangle(bottomTrailingRadius: Self.corner, topTrailingRadius: Self.corner))
        .overlay(alignment: .topLeading) {
            if case let .trim(index, edge) = drag, shown.clips.indices.contains(index) {
                readout(time: edge == .start ? shown.clips[index].start : shown.clips[index].end, track: track)
            }
        }
        .contentShape(.rect)
        .gesture(
            DragGesture(minimumDistance: CGFloat(TrimTrack.dragThreshold))
                .updating($touching) { _, state, _ in state = true }
                .onChanged { value in
                    let position = Double(value.location.x - Self.handle)
                    if drag == nil, !CGRect(x: 0, y: 0, width: width, height: Self.height).contains(value.startLocation) {
                        drag = .ignored
                    }
                    if drag == nil {
                        // What a touch takes hold of is settled at the threshold itself, wherever the first event past it lands.
                        let origin = Double(value.startLocation.x - Self.handle)
                        let threshold = position < origin ? -TrimTrack.dragThreshold : TrimTrack.dragThreshold
                        begin(from: origin, at: origin + threshold, track: track)
                    }
                    move(to: position, track: track)
                }
                .onEnded { _ in finish() }
        )
        .onTapGesture(coordinateSpace: .local) { location in
            guard CGRect(x: 0, y: 0, width: width, height: Self.height).contains(location) else { return }
            let time = min(max(0, track.time(for: Double(location.x - Self.handle))), shown.sourceDuration)
            if shown.clips.count > 1 {
                let index = shown.clipIndex(containingSource: time)
                model.selectedClip = model.selectedClip == index ? nil : index
            }
            model.seek(toSource: time)
        }
        .onChange(of: touching) { _, isTouching in
            if !isTouching { finish() }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Timeline")
        .accessibilityIdentifier("editor-timeline")
    }

    // MARK: Touches

    private func begin(from origin: Double, at position: Double, track: TrimTrack) {
        let timeline = model.timeline
        guard let index = model.activeClip else {
            drag = .scrub
            model.beginScrub()
            return
        }
        let touch = track.touch(
            from: origin,
            at: position,
            clip: timeline.clips[index],
            earliestStart: timeline.earliestStart(ofClipAt: index),
            latestEnd: timeline.latestEnd(ofClipAt: index),
            playhead: timeline.locate(output: model.outputTime).map {
                track.playheadPosition(for: model.playheadSource, in: timeline.clips[$0.index])
            }
        )
        switch touch {
        case .scrub:
            drag = .scrub
            model.beginScrub()
        case let .handle(edge):
            drag = .trim(clip: index, edge: edge)
            model.beginTrim()
        }
    }

    private func move(to position: Double, track: TrimTrack) {
        switch drag {
        case .scrub:
            model.scrub(toSource: track.time(for: position))
        case let .trim(index, edge):
            model.trim(clip: index, edge: edge, toSource: track.time(for: track.edge(edge, forFingerAt: position)))
            expandWhenHeld(clip: index, edge: edge, track: track)
        case .ignored, nil:
            break
        }
    }

    private func expandWhenHeld(clip index: Int, edge: TrimEdge, track: TrimTrack) {
        holdTask?.cancel()
        guard zoom == nil else { return }
        holdTask = Task {
            try? await Task.sleep(for: .seconds(TrimTrack.holdDelay))
            guard !Task.isCancelled, drag == .trim(clip: index, edge: edge),
                  let clips = model.trimPreview?.clips, clips.indices.contains(index)
            else { return }
            let time = edge == .start ? clips[index].start : clips[index].end
            model.loadDetailThumbnails(aroundSource: time)
            withAnimation(.easeOut(duration: 0.2)) {
                zoom = TrimTrack.Zoom(time: time, position: track.position(for: time))
            }
        }
    }

    private func finish() {
        holdTask?.cancel()
        holdTask = nil
        switch drag {
        case .scrub:
            model.endScrub()
        case let .trim(index, edge):
            withAnimation(.easeInOut(duration: 0.3)) {
                zoom = nil
                model.endTrim(clip: index, edge: edge)
            }
        case .ignored, nil:
            break
        }
        drag = nil
    }

    // MARK: Pieces

    private func span(_ from: Double, _ to: Double, track: TrimTrack, width: CGFloat) -> (x: CGFloat, width: CGFloat) {
        let low = min(max(0, Self.handle + CGFloat(track.position(for: from))), width)
        let high = min(max(0, Self.handle + CGFloat(track.position(for: to))), width)
        return (low, max(0, high - low))
    }

    private func film(track: TrimTrack, timeline: EditTimeline, width: CGFloat) -> some View {
        let height = Self.height - 2 * Self.border
        return ZStack(alignment: .topLeading) {
            FilmStrip(model: model, track: track, inset: Self.handle, size: CGSize(width: width, height: height))
            ForEach(Array(timeline.removedRanges.enumerated()), id: \.offset) { _, range in
                let cut = span(range.start, range.end, track: track, width: width)
                Color.black.opacity(0.6)
                    .frame(width: cut.width, height: height)
                    .offset(x: cut.x)
            }
            ForEach(Array(timeline.clips.enumerated().dropFirst()), id: \.offset) { index, clip in
                let x = Self.handle + CGFloat(track.position(for: clip.start))
                if abs(clip.start - timeline.clips[index - 1].end) < 1e-6, x > 0, x < width {
                    Color.black
                        .frame(width: 2, height: height)
                        .offset(x: x - 1)
                }
            }
        }
        .frame(width: width, height: height, alignment: .topLeading)
        .clipped()
        .accessibilityHidden(true)
    }

    private func frame(for clip: EditRange, whole: Bool, track: TrimTrack) -> some View {
        let start = Self.handle + CGFloat(track.position(for: clip.start))
        let end = Self.handle + CGFloat(track.position(for: clip.end))
        let lit = !whole || model.isTrimming
        return ZStack(alignment: .topLeading) {
            TrimFrame(start: start, end: end, handle: Self.handle, border: Self.border, corner: Self.corner)
                .fill(Self.accent, style: FillStyle(eoFill: true))
                .opacity(lit ? 1 : 0)
            ForEach([TrimEdge.start, .end], id: \.self) { edge in
                Image(systemName: edge == .start ? "chevron.compact.left" : "chevron.compact.right")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(lit ? .black : .white)
                    .frame(width: Self.handle, height: Self.height)
                    .offset(x: edge == .start ? start - Self.handle : end)
            }
        }
        .accessibilityHidden(true)
    }

    private func readout(time: Double, track: TrimTrack) -> some View {
        let x = Self.handle + CGFloat(track.position(for: time))
        return ZStack(alignment: .topLeading) {
            Text(Self.clock(time))
                .font(.system(size: 14).monospacedDigit())
                .foregroundStyle(.white)
                .padding(.horizontal, 6.5)
                .frame(height: 22)
                .background(Color(red: 0.5, green: 0.49, blue: 0.535).opacity(0.92), in: .rect(cornerRadius: 5))
                .fixedSize()
                .position(x: x, y: -44)
            Color.white
                .frame(width: 1, height: 18)
                .offset(x: x - 0.5, y: -22)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func accessibilityMarks(timeline: EditTimeline, active: Int?, track: TrimTrack, width: CGFloat) -> some View {
        ForEach(Array(timeline.clips.enumerated()), id: \.offset) { index, clip in
            let kept = span(clip.start, clip.end, track: track, width: width)
            Color.clear
                .frame(width: max(1, kept.width), height: Self.height)
                .offset(x: kept.x)
                .accessibilityElement()
                .accessibilityLabel("Clip \(index + 1), \(CapFormat.timestamp(clip.duration))")
                .accessibilityAddTraits(model.selectedClip == index ? [.isButton, .isSelected] : .isButton)
                .accessibilityAction { model.selectedClip = model.selectedClip == index ? nil : index }
        }
        if let active {
            let clip = timeline.clips[active]
            ForEach([TrimEdge.start, .end], id: \.self) { edge in
                let time = edge == .start ? clip.start : clip.end
                let x = Self.handle + CGFloat(track.position(for: time))
                Color.clear
                    .frame(width: Self.handle, height: Self.height)
                    .offset(x: edge == .start ? x - Self.handle : x)
                    .accessibilityElement()
                    .accessibilityLabel(edge == .start ? "Trim start" : "Trim end")
                    .accessibilityValue(Self.seconds(time))
                    .accessibilityAdjustableAction { direction in
                        let step = direction == .increment ? 0.5 : -0.5
                        model.beginTrim()
                        model.trim(clip: active, edge: edge, toSource: time + step)
                        model.endTrim(clip: active, edge: edge)
                    }
            }
        }
    }

    private static func seconds(_ time: Double) -> String {
        String(format: "%.3f seconds", time)
    }

    private static func clock(_ time: Double) -> String {
        let minutes = Int(time / 60)
        return String(format: "%02d:%05.2f", minutes, time - Double(minutes) * 60)
    }
}

private nonisolated struct TrimFrame: Shape {
    var start: CGFloat
    var end: CGFloat
    let handle: CGFloat
    let border: CGFloat
    let corner: CGFloat

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(start, end) }
        set {
            start = newValue.first
            end = newValue.second
        }
    }

    func path(in rect: CGRect) -> Path {
        var path = Path(
            roundedRect: CGRect(x: start - handle, y: 0, width: end - start + 2 * handle, height: rect.height),
            cornerRadius: corner
        )
        path.addRect(CGRect(x: start, y: border, width: max(0, end - start), height: rect.height - 2 * border))
        return path
    }
}

private struct FilmStrip: View {
    let model: EditorModel
    let track: TrimTrack
    let inset: CGFloat
    let size: CGSize

    var body: some View {
        let tile = max(12, size.height * model.videoAspect)
        let scale = track.pointsPerSecond
        let span = scale > 0 ? Double(tile) / scale : 0
        let low = max(0, track.time(for: -Double(inset)))
        let high = min(track.duration, track.time(for: Double(size.width - inset)))
        let first = span > 0 ? Int((low / span).rounded(.down)) : 0
        let last = span > 0 ? Int((high / span).rounded(.up)) : 0
        let end = inset + CGFloat(track.position(for: track.duration))
        ZStack(alignment: .topLeading) {
            ForEach(first..<max(first, last), id: \.self) { index in
                let x = inset + CGFloat(track.position(for: Double(index) * span))
                Group {
                    if let image = model.thumbnail(atSource: (Double(index) + 0.5) * span, detailed: track.zoom != nil) {
                        Image(uiImage: image).resizable().scaledToFill()
                    } else {
                        Color.white.opacity(0.12)
                    }
                }
                .frame(width: min(tile, max(0, end - x)), height: size.height, alignment: .leading)
                .clipped()
                .offset(x: x)
                .transition(.identity)
            }
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
    }
}

/// Reports its first frame, which is when the editor is really ready.
struct EditorPlayerSurface: UIViewRepresentable {
    let player: AVPlayer
    var onFirstFrame: (@MainActor @Sendable () -> Void)?

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> PlayerLayerView {
        let view = PlayerLayerView()
        view.backgroundColor = .black
        view.isUserInteractionEnabled = false
        view.playerLayer.player = player
        view.playerLayer.videoGravity = .resizeAspect
        if let onFirstFrame {
            context.coordinator.observation = view.playerLayer.observe(\.isReadyForDisplay, options: [.initial, .new]) { layer, _ in
                guard layer.isReadyForDisplay else { return }
                Task { @MainActor in onFirstFrame() }
            }
        }
        return view
    }

    func updateUIView(_ view: PlayerLayerView, context: Context) {
        if view.playerLayer.player !== player { view.playerLayer.player = player }
    }

    final class Coordinator {
        var observation: NSKeyValueObservation?
    }
}
