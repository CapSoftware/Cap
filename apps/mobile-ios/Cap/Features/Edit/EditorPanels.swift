@preconcurrency import AVFoundation
import CapKit
import Photos
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

enum EditorTool: String, CaseIterable, Identifiable {
    case trim
    case presets
    case background
    case frame
    case camera
    case music

    var id: String { rawValue }

    var title: String {
        switch self {
        case .trim: "Trim"
        case .presets: "Presets"
        case .background: "Background"
        case .frame: "Frame"
        case .camera: "Camera"
        case .music: "Music"
        }
    }

    var systemImage: String {
        switch self {
        case .trim: "scissors"
        case .presets: "square.stack"
        case .background: "photo.on.rectangle.angled"
        case .frame: "aspectratio"
        case .camera: "person.crop.circle"
        case .music: "music.note"
        }
    }
}

enum EditorPanels {
    static func height(for tool: EditorTool) -> CGFloat {
        switch tool {
        case .trim: 56
        case .background: 68
        case .presets: 132
        case .camera: 118
        case .frame, .music: 156
        }
    }
}

struct EditorToolBar: View {
    let tools: [EditorTool]
    @Binding var selection: EditorTool

    var body: some View {
        HStack(spacing: 0) {
            ForEach(tools) { tool in
                Button {
                    selection = tool
                } label: {
                    VStack(spacing: 5) {
                        Image(systemName: tool.systemImage)
                            .font(.system(size: 19, weight: .medium))
                            .frame(height: 24)
                        Text(tool.title)
                            .font(.caption2.weight(.medium))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    .foregroundStyle(selection == tool ? Color.white : Color.white.opacity(0.5))
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == tool ? .isSelected : [])
                .accessibilityIdentifier("editor-tool-\(tool.rawValue)")
            }
        }
        .padding(.horizontal, 12)
        .sensoryFeedback(.selection, trigger: selection)
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
    }
}

// MARK: - Preview

struct EditorPreview: View {
    let model: EditorModel
    /// While the camera tool is open, the bubble's place is outlined even where the camera isn't recording.
    var outlinesCamera = false
    @State private var dragPoint: CGPoint?

    var body: some View {
        GeometryReader { proxy in
            let video = Self.videoRect(canvas: model.renderSize, in: proxy.size)
            ZStack(alignment: .topLeading) {
                ZStack {
                    ForEach(model.players.indices, id: \.self) { index in
                        EditorPlayerSurface(player: model.players[index]) { model.metrics.mark("firstFrame") }
                            .zIndex(index == model.activePlayer ? 1 : 0)
                    }
                    EditorPlayerSurface(player: model.sourcePlayer)
                        .zIndex(model.showsSource ? 2 : -1)
                    StillSurface(buffer: model.still, generation: model.stillGeneration)
                        .opacity(model.still == nil ? 0 : 1)
                        .zIndex(3)
                }
                .frame(width: proxy.size.width, height: proxy.size.height)
                .accessibilityHidden(true)

                if let bubble = bubbleRect(in: video) {
                    bubbleHandle(bubble, video: video)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("editor-preview")
    }

    static func videoRect(canvas: CGSize, in size: CGSize) -> CGRect {
        guard canvas.width > 0, canvas.height > 0 else { return CGRect(origin: .zero, size: size) }
        return StudioLayout.fit(canvas, in: CGRect(origin: .zero, size: size))
    }

    private func bubbleRect(in video: CGRect) -> CGRect? {
        guard model.hasCamera, model.hasScreen, model.look.camera.layout == .bubble, model.renderSize.width > 0 else { return nil }
        let layout = StudioLayout(look: model.look, canvas: model.renderSize, primary: model.scene.current.state.screen?.displaySize, camera: model.scene.current.state.camera?.displaySize)
        guard let frame = layout.camera?.frame else { return nil }
        let scale = video.width / model.renderSize.width
        return CGRect(x: video.minX + frame.minX * scale, y: video.minY + frame.minY * scale, width: frame.width * scale, height: frame.height * scale)
    }

    private func bubbleHandle(_ bubble: CGRect, video: CGRect) -> some View {
        let isCircle = model.look.camera.shape == .circle
        let shape = RoundedRectangle(cornerRadius: isCircle ? bubble.width / 2 : bubble.width * 0.22, style: .continuous)
        return ZStack {
            Color.clear
                .frame(width: bubble.width, height: bubble.height)
                .contentShape(shape)
                .position(x: bubble.midX, y: bubble.midY)
                .gesture(
                    DragGesture(minimumDistance: 4)
                        .onChanged { value in dragPoint = value.location }
                        .onEnded { value in
                            dragPoint = nil
                            let scale = model.renderSize.width / max(video.width, 1)
                            let point = CGPoint(x: (value.predictedEndLocation.x - video.minX) * scale, y: (value.predictedEndLocation.y - video.minY) * scale)
                            let corner = StudioLayout.nearestCorner(to: point, in: model.renderSize)
                            model.setLook { $0.camera.corner = corner }
                        }
                )
                .accessibilityElement()
                .accessibilityLabel("Camera bubble")
                .accessibilityHint("Drag to another corner")
                .accessibilityIdentifier("editor-camera-bubble")
            if outlinesCamera, dragPoint == nil {
                shape
                    .strokeBorder(.white.opacity(0.55), style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
                    .frame(width: bubble.width, height: bubble.height)
                    .position(x: bubble.midX, y: bubble.midY)
                    .allowsHitTesting(false)
                    .transition(.opacity)
            }
            if let dragPoint {
                shape
                    .strokeBorder(.white, lineWidth: 2.5)
                    .background(shape.fill(.white.opacity(0.18)))
                    .frame(width: bubble.width, height: bubble.height)
                    .position(dragPoint)
                    .allowsHitTesting(false)
                    .transition(.opacity)
            }
        }
        .animation(.spring(duration: 0.25), value: dragPoint == nil)
        .sensoryFeedback(.impact(weight: .light), trigger: model.look.camera.corner)
    }
}

/// Shows one already-rendered frame. A sample buffer layer takes the GPU buffer as it is, with no copy.
struct StillSurface: UIViewRepresentable {
    let buffer: CVPixelBuffer?
    let generation: Int

    func makeUIView(context: Context) -> StillView { StillView() }

    func updateUIView(_ view: StillView, context: Context) {
        view.show(buffer, generation: generation)
    }

    final class StillView: UIView {
        override class var layerClass: AnyClass { AVSampleBufferDisplayLayer.self }
        private var displayLayer: AVSampleBufferDisplayLayer { layer as! AVSampleBufferDisplayLayer }
        private var shown = -1

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            displayLayer.videoGravity = .resizeAspect
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        func show(_ buffer: CVPixelBuffer?, generation: Int) {
            guard generation != shown else { return }
            shown = generation
            let renderer = displayLayer.sampleBufferRenderer
            guard let buffer else {
                renderer.flush(removingDisplayedImage: true, completionHandler: nil)
                return
            }
            var format: CMVideoFormatDescription?
            CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: buffer, formatDescriptionOut: &format)
            guard let format else { return }
            var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
            var sample: CMSampleBuffer?
            CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: buffer, formatDescription: format, sampleTiming: &timing, sampleBufferOut: &sample)
            guard let sample else { return }
            if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true), CFArrayGetCount(attachments) > 0 {
                let dictionary = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
                CFDictionarySetValue(dictionary, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(), Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
            }
            if renderer.status == .failed { renderer.flush() }
            renderer.enqueue(sample)
        }
    }
}

// MARK: - Panels

private struct PanelSlider: View {
    let title: String
    var showsTitle = true
    let systemImage: String
    let value: Double
    let range: ClosedRange<Double>
    let onBegin: () -> Void
    let onChange: (Double) -> Void
    let onEnd: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 22)
            if showsTitle {
                Text(title)
                    .font(.subheadline)
                    .frame(width: 74, alignment: .leading)
            }
            Slider(value: Binding(get: { value }, set: { onChange($0) }), in: range) { editing in
                if editing { onBegin() } else { onEnd() }
            }
            .tint(.white)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
        .accessibilityValue("\(Int(((value - range.lowerBound) / max(0.0001, range.upperBound - range.lowerBound) * 100).rounded())) percent")
        .accessibilityAdjustableAction { direction in
            let step = (range.upperBound - range.lowerBound) / 10
            onBegin()
            onChange(min(max(range.lowerBound, value + (direction == .increment ? step : -step)), range.upperBound))
            onEnd()
        }
    }
}

private struct Chip: View {
    let title: String
    var systemImage: String?
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let systemImage { Image(systemName: systemImage).font(.system(size: 13, weight: .semibold)) }
                Text(title).font(.subheadline.weight(.semibold)).lineLimit(1)
            }
            .padding(.horizontal, 14)
            .frame(height: 34)
            .foregroundStyle(selected ? Color.black : Color.white)
            .background {
                if selected { Capsule().fill(.white) }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: Capsule())
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct PresetPanel: View {
    let model: EditorModel
    @State private var naming: Naming?
    @State private var name = ""

    private enum Naming: Equatable {
        case new
        case rename(StudioPreset)
    }

    private var studio: StudioSession { StudioSession.shared }
    private var library: StudioPresetLibrary { studio.presetLibrary }
    private static let tile = CGSize(width: 74, height: 98)

    private var pausedMoment: Double? {
        model.isPlaying ? nil : (model.outputTime * 10).rounded() / 10
    }

    var body: some View {
        let selected = library.preset(matching: model.look)
        ScrollViewReader { scroller in
            ScrollView(.horizontal) {
                LazyHStack(alignment: .top, spacing: 12) {
                    saveCard(isSaved: selected != nil)
                    ForEach(library.all) { preset in
                        card(preset, selected: preset.id == selected?.id)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
            }
            .scrollIndicators(.hidden)
            .onAppear {
                if let selected { scroller.scrollTo(selected.id, anchor: .center) }
            }
        }
        .sensoryFeedback(.selection, trigger: selected?.id)
        .onChange(of: library) { _, library in model.loadPresetThumbnails(library.all) }
        // Redrawn once a paused seek settles: a scrub changes this many times, and each change cancels the last wait.
        .task(id: pausedMoment) {
            guard pausedMoment != nil else { return }
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled else { return }
            model.loadPresetThumbnails(library.all)
        }
        .alert(naming == .new ? "Save Preset" : "Rename Preset", isPresented: Binding(get: { naming != nil }, set: { if !$0 { naming = nil } })) {
            TextField("Name", text: $name)
                .submitLabel(.done)
            Button("Save") { finishNaming() }
            Button("Cancel", role: .cancel) { naming = nil }
        } message: {
            if naming == .new { Text("Keeps this background, frame and camera layout for any recording.") }
        }
    }

    private func saveCard(isSaved: Bool) -> some View {
        Button {
            name = library.uniqueName("My Look")
            naming = .new
        } label: {
            VStack(spacing: 7) {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
                    .foregroundStyle(.white.opacity(0.35))
                    .frame(width: Self.tile.width, height: Self.tile.height)
                    .overlay {
                        Image(systemName: "plus")
                            .font(.system(size: 22, weight: .medium))
                            .foregroundStyle(.white.opacity(0.85))
                    }
                Text("Save")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.white.opacity(0.75))
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .opacity(isSaved ? 0.4 : 1)
        .disabled(isSaved)
        .accessibilityLabel("Save as Preset")
        .accessibilityHint(isSaved ? "This look is already a preset." : "")
    }

    private func card(_ preset: StudioPreset, selected: Bool) -> some View {
        let isDefault = library.defaultPreset.id == preset.id
        return Button {
            model.apply(preset)
        } label: {
            VStack(spacing: 7) {
                ZStack {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(.white.opacity(0.06))
                    PresetPicture(preset: preset, image: model.presetThumbnails[preset.look], tile: Self.tile)
                }
                .frame(width: Self.tile.width, height: Self.tile.height)
                .overlay {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(selected ? Color.white : Color.white.opacity(0.1), lineWidth: selected ? 2.5 : 1)
                }
                .scaleEffect(selected ? 1.03 : 1)
                .animation(.spring(duration: 0.22), value: selected)
                HStack(spacing: 3) {
                    if isDefault {
                        Image(systemName: "pin.fill").font(.system(size: 8, weight: .semibold))
                    }
                    Text(preset.name).lineLimit(1)
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(selected ? Color.white : Color.white.opacity(0.65))
                .frame(maxWidth: Self.tile.width + 8)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .id(preset.id)
        .contextMenu {
            if !isDefault {
                Button("Use for New Recordings", systemImage: "pin") { studio.makeDefault(preset.id) }
            }
            if !preset.isBuiltIn {
                if preset.look != model.look {
                    Button("Update to Current Look", systemImage: "arrow.triangle.2.circlepath") {
                        studio.updatePreset(preset.id, look: model.look, from: model.workDirectory)
                    }
                }
                Button("Rename", systemImage: "pencil") {
                    name = preset.name
                    naming = .rename(preset)
                }
                Button("Delete", systemImage: "trash", role: .destructive) { studio.deletePreset(preset.id) }
            }
        }
        .accessibilityLabel(preset.name)
        .accessibilityValue(isDefault ? "Used for new recordings" : "")
        .accessibilityIdentifier("editor-preset")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func finishNaming() {
        switch naming {
        case .new:
            studio.savePreset(named: name, look: model.look, from: model.workDirectory)
        case let .rename(preset):
            studio.renamePreset(preset.id, to: name)
        case nil:
            break
        }
        naming = nil
    }
}

/// The same blooms as the renderer draws, in SwiftUI, for swatches and placeholders.
struct GlowSwatch: View {
    let glow: StudioGlow

    var body: some View {
        GeometryReader { proxy in
            Canvas { context, size in
                let frame = Path(CGRect(origin: .zero, size: size))
                let long = max(size.width, size.height)
                context.fill(frame, with: .color(swiftUI(glow.base)))
                for bloom in glow.blooms {
                    let color = swiftUI(bloom.color)
                    context.fill(frame, with: .radialGradient(Gradient(colors: [color.opacity(0.95), color.opacity(0)]), center: CGPoint(x: bloom.x * size.width, y: bloom.y * size.height), startRadius: 0, endRadius: bloom.radius * long))
                }
            }
            .blur(radius: StudioGlow.softness * min(proxy.size.width, proxy.size.height) * 2, opaque: true)
        }
    }

    private func swiftUI(_ color: StudioColor) -> Color {
        let c = color.components
        return Color(red: c.red, green: c.green, blue: c.blue)
    }
}

/// The preset drawn on this video's frame once it's ready, its background until then.
private struct PresetPicture: View {
    let preset: StudioPreset
    let image: UIImage?
    let tile: CGSize

    var body: some View {
        let inner = CGSize(width: tile.width - 10, height: tile.height - 10)
        let shape = fitted(inner)
        ZStack {
            placeholder
                .frame(width: shape.width, height: shape.height)
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .interpolation(.high)
                    .frame(width: shape.width, height: shape.height)
                    .transition(.opacity)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        .shadow(color: .black.opacity(0.35), radius: 4, y: 2)
        .animation(.easeOut(duration: 0.2), value: image != nil)
    }

    private func fitted(_ box: CGSize) -> CGSize {
        let ratio = image.map { $0.size.width / max(1, $0.size.height) } ?? preset.look.aspect.ratio.map { CGFloat($0) } ?? 9.0 / 16
        return box.width / box.height > ratio
            ? CGSize(width: (box.height * ratio).rounded(), height: box.height)
            : CGSize(width: box.width, height: (box.width / ratio).rounded())
    }

    @ViewBuilder
    private var placeholder: some View {
        switch preset.look.background {
        case let .wallpaper(name):
            if let thumbnail = StudioAssets.wallpaperThumbnail(name) {
                Image(uiImage: thumbnail).resizable().scaledToFill()
            } else {
                Color.white.opacity(0.08)
            }
        case .color, .gradient, .glow:
            BackgroundPanel.fill(preset.look.background)
        default:
            Color.white.opacity(0.08)
        }
    }
}

struct BackgroundPanel: View {
    let model: EditorModel
    @State private var picked: PhotosPickerItem?

    var body: some View {
        ScrollViewReader { scroller in
            ScrollView(.horizontal) {
                LazyHStack(spacing: 10) {
                    swatch(.none, label: "None") {
                        Image(systemName: "nosign")
                            .font(.system(size: 20, weight: .medium))
                            .foregroundStyle(.white.opacity(0.7))
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(Color.white.opacity(0.08))
                    }
                    let photo = photo
                    let isPhoto = isPhoto
                    let side = Self.side
                    PhotosPicker(selection: $picked, matching: .images, photoLibrary: .shared()) {
                        PhotoSwatch(image: photo, selected: isPhoto, side: side)
                    }
                    .accessibilityLabel("Choose a photo")
                    divider
                    ForEach(Array(StudioBackground.glows.enumerated()), id: \.offset) { _, background in
                        swatch(background, label: "Glow") { Self.fill(background) }
                    }
                    divider
                    ForEach(StudioAssets.wallpapers, id: \.self) { name in
                        swatch(.wallpaper(name), label: "Wallpaper") {
                            if let image = StudioAssets.wallpaperThumbnail(name) {
                                Image(uiImage: image).resizable().scaledToFill()
                            }
                        }
                    }
                    divider
                    ForEach(Array(StudioBackground.gradients.enumerated()), id: \.offset) { _, background in
                        swatch(background, label: "Gradient") { Self.fill(background) }
                    }
                    divider
                    ForEach(Array(StudioBackground.colors.enumerated()), id: \.offset) { _, background in
                        swatch(background, label: "Colour") { Self.fill(background) }
                    }
                }
                .padding(.horizontal, 16)
                .frame(height: Self.side + 8)
            }
            .scrollIndicators(.hidden)
            .onAppear {
                if let id = selectedID { scroller.scrollTo(id, anchor: .center) }
            }
        }
        .padding(.top, 2)
        .onChange(of: picked) { _, item in
            guard let item else { return }
            Task { await usePhoto(item) }
        }
    }

    private static let side: CGFloat = 52

    private var photo: UIImage? {
        guard case let .image(file) = model.look.background else { return nil }
        return UIImage(contentsOfFile: model.workDirectory.appending(path: file).path)
    }

    private var isPhoto: Bool {
        if case .image = model.look.background { true } else { false }
    }

    private var selectedID: String? { String(describing: model.look.background) }

    private var divider: some View {
        Capsule().fill(.white.opacity(0.15)).frame(width: 1, height: 30)
    }

    private func ring(selected: Bool) -> some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(selected ? Color.white : Color.white.opacity(0.12), lineWidth: selected ? 2.5 : 1)
    }

    private func swatch(_ background: StudioBackground, label: String, @ViewBuilder content: () -> some View) -> some View {
        let selected = model.look.background == background
        return Button {
            model.setLook { look in
                look.background = background
                // Picking a background for an untouched video frames it, or the background would never show.
                if !background.isNone, look.padding == 0, look.aspect == .auto {
                    look.padding = StudioLook.studioDefault.padding
                    look.rounding = StudioLook.studioDefault.rounding
                    look.shadow = StudioLook.studioDefault.shadow
                }
            }
        } label: {
            content()
                .frame(width: Self.side, height: Self.side)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(ring(selected: selected))
                .scaleEffect(selected ? 1.04 : 1)
                .animation(.spring(duration: 0.2), value: selected)
        }
        .buttonStyle(.plain)
        .id(String(describing: background))
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    static func fill(_ background: StudioBackground) -> some View {
        Group {
            switch background {
            case let .color(color):
                let c = color.components
                Color(red: c.red, green: c.green, blue: c.blue)
            case let .gradient(from, to, _):
                let a = from.components
                let b = to.components
                LinearGradient(colors: [Color(red: a.red, green: a.green, blue: a.blue), Color(red: b.red, green: b.green, blue: b.blue)], startPoint: .topLeading, endPoint: .bottomTrailing)
            case let .glow(id):
                if let glow = StudioGlow.named(id) { GlowSwatch(glow: glow) } else { Color.clear }
            default:
                Color.clear
            }
        }
    }

    /// Kept next to the edit at a size that covers any frame, so the original photo is never needed again.
    private func usePhoto(_ item: PhotosPickerItem) async {
        defer { picked = nil }
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }
        let directory = model.workDirectory
        let name = "background-\(UUID().uuidString.prefix(8)).jpg"
        let saved: Bool = await Task.detached(priority: .userInitiated) {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                      kCGImageSourceCreateThumbnailFromImageAlways: true,
                      kCGImageSourceThumbnailMaxPixelSize: 2400,
                      kCGImageSourceCreateThumbnailWithTransform: true,
                  ] as CFDictionary),
                  let jpeg = UIImage(cgImage: image).jpegData(compressionQuality: 0.85)
            else { return false }
            return (try? jpeg.write(to: directory.appending(path: name), options: .atomic)) != nil
        }.value
        guard saved else { return }
        model.setLook { look in
            look.background = .image(name)
            if look.padding == 0, look.aspect == .auto {
                look.padding = StudioLook.studioDefault.padding
                look.rounding = StudioLook.studioDefault.rounding
                look.shadow = StudioLook.studioDefault.shadow
            }
        }
    }
}

private struct PhotoSwatch: View {
    let image: UIImage?
    let selected: Bool
    let side: CGFloat

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Color.white.opacity(0.08)
                Image(systemName: "photo.on.rectangle")
                    .font(.system(size: 19, weight: .medium))
                    .foregroundStyle(.white.opacity(0.75))
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(selected ? Color.white : Color.white.opacity(0.12), lineWidth: selected ? 2.5 : 1)
        )
    }
}

struct FramePanel: View {
    let model: EditorModel

    var body: some View {
        VStack(spacing: 10) {
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(StudioAspect.allCases) { aspect in
                        Chip(title: aspect.title, systemImage: Self.symbol(aspect), selected: model.look.aspect == aspect) {
                            model.setLook { $0.aspect = aspect }
                        }
                    }
                }
                .padding(.horizontal, 16)
            }
            .scrollIndicators(.hidden)

            VStack(spacing: 2) {
                slider("Padding", "square.dashed", \.padding, StudioLook.paddingRange)
                slider("Corners", "rectangle.roundedtop", \.rounding, StudioLook.roundingRange)
                slider("Shadow", "shadow", \.shadow, 0...1)
            }
            .padding(.horizontal, 20)
        }
        .padding(.top, 6)
    }

    private func slider(_ title: String, _ symbol: String, _ path: WritableKeyPath<StudioLook, Double>, _ range: ClosedRange<Double>) -> some View {
        PanelSlider(title: title, systemImage: symbol, value: model.look[keyPath: path], range: range) {
            model.beginLookGesture()
        } onChange: { value in
            model.setLook { look in
                look[keyPath: path] = value
                // Padding, corners and shadow only show against a background.
                if look.background.isNone, value > 0 { look.background = StudioBackground.gradients[0] }
            }
        } onEnd: {
            model.endLookGesture()
        }
    }

    private static func symbol(_ aspect: StudioAspect) -> String {
        switch aspect {
        case .auto: "arrow.up.left.and.arrow.down.right"
        case .portrait: "rectangle.portrait"
        case .fourFive: "rectangle.portrait"
        case .square: "square"
        case .landscape: "rectangle"
        }
    }
}

struct CameraPanel: View {
    let model: EditorModel

    var body: some View {
        VStack(spacing: 12) {
            HStack(spacing: 8) {
                ForEach(StudioCameraLayout.allCases) { layout in
                    Chip(title: layout.title, selected: model.look.camera.layout == layout) {
                        model.setLook { $0.camera.layout = layout }
                    }
                }
            }
            if model.look.camera.layout == .bubble {
                HStack(spacing: 14) {
                    ForEach(StudioCameraShape.allCases) { shape in
                        Button {
                            model.setLook { $0.camera.shape = shape }
                        } label: {
                            Image(systemName: Self.symbol(shape))
                                .font(.system(size: 18, weight: .medium))
                                .frame(width: 40, height: 34)
                                .foregroundStyle(model.look.camera.shape == shape ? .white : .white.opacity(0.45))
                                .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(shape.rawValue.capitalized)
                        .accessibilityAddTraits(model.look.camera.shape == shape ? .isSelected : [])
                    }
                    Capsule().fill(.white.opacity(0.15)).frame(width: 1, height: 24)
                    PanelSlider(title: "Size", showsTitle: false, systemImage: "arrow.up.left.and.arrow.down.right", value: model.look.camera.size, range: StudioCameraLook.sizeRange) {
                        model.beginLookGesture()
                    } onChange: { value in
                        model.setLook { $0.camera.size = value }
                    } onEnd: {
                        model.endLookGesture()
                    }
                }
                .padding(.horizontal, 20)
            }
        }
        .padding(.top, 8)
    }

    private static func symbol(_ shape: StudioCameraShape) -> String {
        switch shape {
        case .circle: "circle"
        case .rounded: "app"
        case .square: "square"
        }
    }
}

struct MusicPanel: View {
    let model: EditorModel
    @State private var importing = false

    var body: some View {
        VStack(spacing: 10) {
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    Chip(title: "None", systemImage: "speaker.slash", selected: model.music == nil) {
                        Task { await model.setMusic(nil) }
                    }
                    Chip(title: "Import", systemImage: "folder", selected: isImported) {
                        importing = true
                    }
                    ForEach(StudioAssets.music) { track in
                        Chip(title: track.title, systemImage: "music.note", selected: model.music?.source == .builtIn(track.id)) {
                            Task { await model.setMusic(StudioMusic(source: .builtIn(track.id), title: track.title, volume: model.music?.volume ?? 0.35)) }
                        }
                    }
                }
                .padding(.horizontal, 16)
            }
            .scrollIndicators(.hidden)

            if model.music != nil {
                Waveform(peaks: model.musicWaveform)
                    .frame(height: 16)
                    .padding(.horizontal, 22)
                    .accessibilityHidden(true)
            }

            VStack(spacing: 2) {
                if let music = model.music {
                    PanelSlider(title: "Music", systemImage: "music.note", value: music.volume, range: 0...1) {
                        model.beginAudioGesture()
                    } onChange: { value in
                        model.setVolumes(music: value, voice: nil)
                    } onEnd: {
                        model.endLookGesture()
                    }
                }
                PanelSlider(title: "Voice", systemImage: "waveform", value: model.voiceVolume, range: 0...1.5) {
                    model.beginAudioGesture()
                } onChange: { value in
                    model.setVolumes(music: nil, voice: value)
                } onEnd: {
                    model.endLookGesture()
                }
            }
            .padding(.horizontal, 20)
        }
        .padding(.top, 6)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.audio]) { result in
            guard case let .success(url) = result else { return }
            Task { await importMusic(url) }
        }
    }

    private var isImported: Bool {
        if case .file = model.music?.source { true } else { false }
    }

    private func importMusic(_ url: URL) async {
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        let name = "music-\(UUID().uuidString.prefix(8)).\(url.pathExtension.isEmpty ? "m4a" : url.pathExtension)"
        let destination = model.workDirectory.appending(path: name)
        do {
            try FileManager.default.copyItem(at: url, to: destination)
        } catch {
            return
        }
        await model.setMusic(StudioMusic(source: .file(name), title: url.deletingPathExtension().lastPathComponent, volume: model.music?.volume ?? 0.35))
    }
}

private struct Waveform: View {
    let peaks: [Float]

    var body: some View {
        Canvas { context, size in
            guard !peaks.isEmpty else { return }
            let step = size.width / CGFloat(peaks.count)
            var path = Path()
            for (index, peak) in peaks.enumerated() {
                let height = max(1.5, CGFloat(peak) * size.height)
                path.addRoundedRect(in: CGRect(x: CGFloat(index) * step, y: (size.height - height) / 2, width: max(1, step * 0.55), height: height), cornerSize: CGSize(width: 0.75, height: 0.75))
            }
            context.fill(path, with: .color(.white.opacity(0.45)))
        }
    }
}

// MARK: - Export

struct ExportProgressCard: View {
    let progress: Double
    let title: String
    let onCancel: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.45).ignoresSafeArea()
            VStack(spacing: 14) {
                Text(title)
                    .font(.headline)
                ProgressView(value: progress)
                    .progressViewStyle(.linear)
                    .tint(.white)
                    .frame(width: 200)
                Text("\(Int((progress * 100).rounded()))%")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .contentTransition(.numericText())
                Button("Cancel", role: .cancel, action: onCancel)
                    .buttonStyle(.glass)
            }
            .padding(24)
            .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("editor-export-progress")
    }
}

/// Renders on the phone while Cap is in front (iOS refuses GPU work in the background), then hands the file to the
/// background upload or Photos.
@MainActor
@Observable
final class EditorExport {
    private(set) var isRunning = false
    private(set) var progress: Double = 0
    private(set) var title = "Rendering"
    var errorMessage: String?
    @ObservationIgnored private var exporter: StudioExporter?
    @ObservationIgnored private weak var rendering: EditorModel?
    @ObservationIgnored private var cancelRequested = false

    func cancel() {
        cancelRequested = true
        exporter?.cancel()
        rendering?.stopWaitingForMedia()
    }

    private func render(_ model: EditorModel, title: String) async -> StudioExporter.Result? {
        guard !isRunning else { return nil }
        isRunning = true
        progress = 0
        self.title = title
        cancelRequested = false
        rendering = model
        defer {
            isRunning = false
            exporter = nil
            rendering = nil
        }
        model.pauseForExport()
        let exporter = StudioExporter()
        self.exporter = exporter
        // iOS refuses GPU work from the background, so leaving Cap would fail the render part way.
        let leftScreen = LeftScreen()
        let observer = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            leftScreen.value = true
            exporter.cancel()
        }
        defer { NotificationCenter.default.removeObserver(observer) }
        do {
            await model.waitForMedia()
            guard !cancelRequested else { return nil }
            let built = try model.exportComposition()
            let url = try UploadCenter.stagingURL(extension: "mp4")
            UIApplication.shared.isIdleTimerDisabled = true
            defer { UIApplication.shared.isIdleTimerDisabled = false }
            let result = try await exporter.export(built, to: url) { [weak self] value in
                Task { @MainActor in
                    guard let self, value > self.progress + 0.01 || value >= 1 else { return }
                    self.progress = value
                }
            }
            model.metrics.record("exportSeconds", result.seconds)
            model.metrics.record("exportRealtime", result.duration / max(result.seconds, 0.001))
            ProcessStats.note("Studio export \(Int(result.size.width))x\(Int(result.size.height)) \(String(format: "%.1f", result.duration)) s in \(String(format: "%.2f", result.seconds)) s, \(result.bytes / 1024) KB")
            return result
        } catch StudioExporter.Failure.cancelled {
            if leftScreen.value { errorMessage = "Rendering stopped when Cap left the screen. Keep Cap open until it finishes." }
            return nil
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Cap couldn't render this video. Try again."
            return nil
        }
    }

    /// Uploads the rendered video as a new Cap through the usual background upload.
    func share(_ model: EditorModel, session: SessionModel) async -> Bool {
        // Cap holds free Caps to five minutes however they arrive. Said before rendering rather than after it.
        if !session.isPro, model.timeline.outputDuration > RecordingLimits.freeDuration + RecordingLimits.freeTolerance {
            errorMessage = "Caps on the free plan can be up to 5 minutes. Trim this one to 5 minutes, save it to Photos, or upgrade to Pro."
            Usage.track("editor_share_over_free_limit", ["studio": .bool(model.isStudio), "seconds": .int(Int(model.timeline.outputDuration.rounded()))])
            return false
        }
        guard let result = await render(model, title: "Rendering") else { return false }
        let name = model.title
        let url = result.url
        session.uploads.enqueue(displayName: name, folderId: nil) {
            try await UploadCenter.probe(url, fileName: "\(name).mp4", contentType: "video/mp4")
        }
        Usage.track("editor_rendered", ["studio": .bool(model.isStudio), "seconds": .int(Int(result.duration.rounded()))])
        session.toasts.show(model.isStudio ? "Uploading your video. Its link is ready when it finishes." : "Uploading as a new Cap. Your original stays as it is.", systemImage: "arrow.up.circle.fill")
        return true
    }

    func saveToPhotos(_ model: EditorModel) async -> Bool {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else {
            errorMessage = "Allow Cap to add to Photos in Settings to save videos there."
            return false
        }
        guard let result = await render(model, title: "Saving to Photos") else { return false }
        defer { try? FileManager.default.removeItem(at: result.url) }
        do {
            try await PhotoLibrary.addVideo(at: result.url)
            Usage.track("editor_saved_to_photos", ["studio": .bool(model.isStudio)])
            return true
        } catch {
            errorMessage = "Cap couldn't save the video to Photos. Try again."
            return false
        }
    }
}

nonisolated private final class LeftScreen: @unchecked Sendable {
    var value = false
}
