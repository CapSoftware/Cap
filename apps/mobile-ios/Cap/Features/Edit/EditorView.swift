import AVFoundation
import CapKit
import SwiftUI
import UIKit

struct EditorView: View {
    @State var model: EditorModel
    let onFinished: (EditorOutcome) -> Void

    @State private var confirmingDiscard = false
    @State private var confirmingRestore = false

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
                        .opacity(index == model.activePlayer ? 1 : 0)
                }
                if model.isTrimming {
                    EditorPlayerSurface(player: model.sourcePlayer)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityHidden(true)

            HStack {
                Button(action: model.togglePlay) {
                    Image(systemName: model.isPlaying ? "pause.fill" : "play.fill")
                        .font(.title2)
                        .frame(width: 44, height: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(model.isPlaying ? "Pause" : "Play")
                Spacer()
                Text("\(CapFormat.timestamp(model.outputTime)) / \(CapFormat.timestamp(model.displayedTimeline.outputDuration))")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Edited length \(CapFormat.timestamp(model.displayedTimeline.outputDuration))")
            }
            .padding(.horizontal, 16)

            EditorTimeline(model: model)
                .frame(height: 58)
                .padding(.horizontal, 16)

            HStack(spacing: 10) {
                toolButton("Undo", systemImage: "arrow.uturn.backward", enabled: model.canUndo, action: model.undo)
                toolButton("Redo", systemImage: "arrow.uturn.forward", enabled: model.canRedo, action: model.redo)
                Spacer()
                if model.state.hasEdits {
                    toolButton("Restore original", systemImage: "clock.arrow.circlepath", enabled: !model.isSaving) {
                        confirmingRestore = true
                    }
                }
                toolButton("Split", systemImage: "scissors", enabled: model.canSplit, action: model.split)
                toolButton("Delete", systemImage: "trash", enabled: model.canDelete, action: model.deleteSelected)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
        .sensoryFeedback(.impact(weight: .medium), trigger: model.timeline.clips.count)
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

private struct EditorTimeline: View {
    let model: EditorModel

    private static let gap: CGFloat = 4
    private static let handle: CGFloat = 16
    private static let accent = Color(red: 1, green: 0.8, blue: 0.0)

    @State private var scrubbing = false
    @State private var trimOrigin: Double?
    @State private var pointsPerSecond: CGFloat = 1

    var body: some View {
        GeometryReader { proxy in
            let committed = model.timeline
            let shown = model.displayedTimeline
            let gaps = Self.gap * CGFloat(max(0, committed.clips.count - 1))
            let scale = committed.outputDuration > 0 ? (proxy.size.width - gaps) / committed.outputDuration : 1
            let layout = Self.layout(shown, scale: trimOrigin == nil ? scale : pointsPerSecond)
            ZStack(alignment: .topLeading) {
                ForEach(Array(shown.clips.enumerated()), id: \.offset) { index, clip in
                    ClipStrip(model: model, clip: clip, size: CGSize(width: layout[index].width, height: proxy.size.height))
                        .frame(width: layout[index].width, height: proxy.size.height)
                        .clipShape(.rect(cornerRadius: 6))
                        .overlay {
                            if model.selectedClip == index {
                                RoundedRectangle(cornerRadius: 6).strokeBorder(Self.accent, lineWidth: 3)
                            }
                        }
                        .offset(x: layout[index].x)
                        .accessibilityElement()
                        .accessibilityLabel("Clip \(index + 1), \(CapFormat.timestamp(clip.duration))")
                        .accessibilityAddTraits(model.selectedClip == index ? [.isButton, .isSelected] : .isButton)
                        .accessibilityAction { model.selectedClip = model.selectedClip == index ? nil : index }
                }

                if let index = model.selectedClip, layout.indices.contains(index) {
                    handle(index: index, edge: .start, layout: layout, height: proxy.size.height, scale: scale)
                    handle(index: index, edge: .end, layout: layout, height: proxy.size.height, scale: scale)
                }

                Capsule()
                    .fill(.white)
                    .frame(width: 3, height: proxy.size.height + 12)
                    .shadow(color: .black.opacity(0.5), radius: 2)
                    .offset(x: Self.x(forOutput: model.outputTime, timeline: shown, layout: layout) - 1.5, y: -6)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
            .contentShape(.rect)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        if !scrubbing, abs(value.translation.width) > 3 {
                            scrubbing = true
                            model.beginScrub()
                        }
                        if scrubbing {
                            model.scrub(toOutput: Self.output(forX: value.location.x, timeline: shown, layout: layout))
                        }
                    }
                    .onEnded { value in
                        if scrubbing {
                            scrubbing = false
                            model.endScrub()
                        } else {
                            let time = Self.output(forX: value.location.x, timeline: shown, layout: layout)
                            let index = shown.locate(output: time)?.index
                            model.selectedClip = model.selectedClip == index ? nil : index
                            model.seek(toOutput: time)
                        }
                    }
            )
            .onAppear { pointsPerSecond = scale }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Timeline")
            .accessibilityIdentifier("editor-timeline")
        }
    }

    private func handle(index: Int, edge: EditorModel.Edge, layout: [(x: CGFloat, width: CGFloat)], height: CGFloat, scale: CGFloat) -> some View {
        let frame = layout[index]
        let x = edge == .start ? frame.x - Self.handle + 3 : frame.x + frame.width - 3
        return RoundedRectangle(cornerRadius: 5)
            .fill(Self.accent)
            .frame(width: Self.handle, height: height)
            .overlay {
                Image(systemName: edge == .start ? "chevron.compact.left" : "chevron.compact.right")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(.black)
            }
            .offset(x: x)
            .contentShape(.rect.inset(by: -10))
            .highPriorityGesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        if trimOrigin == nil {
                            pointsPerSecond = scale
                            let clip = model.timeline.clips[index]
                            trimOrigin = edge == .start ? clip.start : clip.end
                            model.beginTrim()
                        }
                        guard let origin = trimOrigin else { return }
                        model.trim(clip: index, edge: edge, toSource: origin + Double(value.translation.width / pointsPerSecond))
                    }
                    .onEnded { _ in
                        trimOrigin = nil
                        model.endTrim(clip: index, edge: edge)
                    }
            )
            .accessibilityLabel(edge == .start ? "Trim start" : "Trim end")
            .accessibilityAdjustableAction { direction in
                let step = direction == .increment ? 0.5 : -0.5
                let clip = model.timeline.clips[index]
                model.beginTrim()
                model.trim(clip: index, edge: edge, toSource: (edge == .start ? clip.start : clip.end) + step)
                model.endTrim(clip: index, edge: edge)
            }
    }

    static func layout(_ timeline: EditTimeline, scale: CGFloat) -> [(x: CGFloat, width: CGFloat)] {
        var x: CGFloat = 0
        return timeline.clips.map { clip in
            let width = max(2, CGFloat(clip.duration) * scale)
            defer { x += width + gap }
            return (x, width)
        }
    }

    static func x(forOutput time: Double, timeline: EditTimeline, layout: [(x: CGFloat, width: CGFloat)]) -> CGFloat {
        guard let (index, offset) = timeline.locate(output: time), layout.indices.contains(index) else { return 0 }
        let clip = timeline.clips[index]
        let fraction = clip.duration > 0 ? offset / clip.duration : 0
        return layout[index].x + layout[index].width * CGFloat(fraction)
    }

    static func output(forX x: CGFloat, timeline: EditTimeline, layout: [(x: CGFloat, width: CGFloat)]) -> Double {
        let starts = timeline.outputStarts
        for (index, frame) in layout.enumerated() where x <= frame.x + frame.width || index == layout.count - 1 {
            let fraction = min(max(0, (x - frame.x) / max(1, frame.width)), 1)
            return starts[index] + timeline.clips[index].duration * Double(fraction)
        }
        return 0
    }
}

private struct ClipStrip: View {
    let model: EditorModel
    let clip: EditRange
    let size: CGSize

    var body: some View {
        let tile = max(24, size.height * 0.75)
        let count = max(1, Int((size.width / tile).rounded(.up)))
        HStack(spacing: 0) {
            ForEach(0..<count, id: \.self) { index in
                let time = clip.start + clip.duration * (Double(index) + 0.5) / Double(count)
                Group {
                    if let image = model.thumbnail(atSource: time) {
                        Image(uiImage: image).resizable().scaledToFill()
                    } else {
                        Color.white.opacity(0.12)
                    }
                }
                .frame(width: tile, height: size.height)
                .clipped()
            }
        }
        .frame(width: size.width, height: size.height, alignment: .leading)
        .clipped()
        .background(Color.white.opacity(0.08))
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
