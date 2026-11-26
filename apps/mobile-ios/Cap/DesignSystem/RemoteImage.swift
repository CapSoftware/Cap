import CapKit
import SwiftUI
import UIKit

private struct ImagePipelineKey: EnvironmentKey {
    static let defaultValue: ImagePipeline? = nil
}

extension EnvironmentValues {
    var imagePipeline: ImagePipeline? {
        get { self[ImagePipelineKey.self] }
        set { self[ImagePipelineKey.self] = newValue }
    }
}

struct RemoteImage<Placeholder: View>: View {
    let request: ImageRequest?
    @ViewBuilder var placeholder: () -> Placeholder

    @Environment(\.imagePipeline) private var pipeline
    @Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?
    @State private var loadedKey: String?

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
            } else {
                placeholder()
            }
        }
        .task(id: request?.cacheKey) {
            await load()
        }
    }

    private func load() async {
        guard let request, let pipeline else {
            image = nil
            return
        }
        if loadedKey == request.cacheKey, image != nil { return }
        if let cached = pipeline.cachedImage(for: request) {
            image = UIImage(cgImage: cached, scale: displayScale, orientation: .up)
            loadedKey = request.cacheKey
            return
        }
        do {
            let cgImage = try await pipeline.image(for: request)
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.2)) {
                image = UIImage(cgImage: cgImage, scale: displayScale, orientation: .up)
            }
            loadedKey = request.cacheKey
        } catch {
            if loadedKey != request.cacheKey { image = nil }
        }
    }
}

struct AvatarView: View {
    let name: String
    let imageURL: String?
    var size: CGFloat = 36

    @Environment(\.capEnvironment) private var environment
    @Environment(\.displayScale) private var displayScale

    private var initials: String {
        let parts = name.split(whereSeparator: \.isWhitespace).prefix(2)
        let letters = parts.compactMap(\.first).map { String($0).uppercased() }.joined()
        return letters
    }

    private var request: ImageRequest? {
        guard let url = SafeURL.media(imageURL, environment: environment) else { return nil }
        return ImageRequest(url: url, maxPixelSize: Int(size * displayScale))
    }

    var body: some View {
        RemoteImage(request: request) {
            ZStack {
                Circle().fill(CapTheme.blue.gradient)
                if initials.isEmpty {
                    Image(systemName: "person.fill")
                        .font(.system(size: size * 0.45, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.9))
                } else {
                    Text(initials)
                        .font(.system(size: size * 0.4, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(.circle)
        .overlay(Circle().strokeBorder(.primary.opacity(0.08), lineWidth: 0.5))
        .accessibilityHidden(true)
    }
}

struct OrganizationIcon: View {
    let name: String
    let iconURL: String?
    var size: CGFloat = 28

    @Environment(\.capEnvironment) private var environment
    @Environment(\.displayScale) private var displayScale

    private var request: ImageRequest? {
        guard let url = SafeURL.media(iconURL, environment: environment) else { return nil }
        return ImageRequest(url: url, maxPixelSize: Int(size * displayScale))
    }

    var body: some View {
        RemoteImage(request: request) {
            ZStack {
                RoundedRectangle(cornerRadius: size * 0.28, style: .continuous).fill(Color.secondary.opacity(0.18))
                Text(name.prefix(1).uppercased())
                    .font(.system(size: size * 0.48, weight: .semibold, design: .rounded))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .clipShape(.rect(cornerRadius: size * 0.28, style: .continuous))
        .accessibilityHidden(true)
    }
}

struct CapThumbnail: View {
    let cap: CapSummary
    var cornerRadius: CGFloat = CapTheme.thumbnailRadius
    var showsBadges = true

    @Environment(\.capEnvironment) private var environment
    @Environment(\.displayScale) private var displayScale

    private func request(width: CGFloat) -> ImageRequest? {
        guard let url = SafeURL.media(cap.thumbnailUrl, environment: environment) else { return nil }
        let bucket = max(320, Int((width * displayScale / 160).rounded(.up)) * 160)
        return ImageRequest(url: url, cacheKey: cap.thumbnailCacheKey ?? "cap-thumbnail:\(cap.id):\(cap.updatedAt.timeIntervalSince1970)", maxPixelSize: bucket)
    }

    var body: some View {
        Color.clear
            .aspectRatio(16 / 9, contentMode: .fit)
            .overlay {
                GeometryReader { proxy in
                    RemoteImage(request: request(width: proxy.size.width)) {
                        ThumbnailPlaceholder(isProcessing: cap.isProcessing)
                    }
                    .frame(width: proxy.size.width, height: proxy.size.height)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if showsBadges, let duration = CapFormat.duration(cap.durationSeconds), !cap.isProcessing {
                    GlassBadge(text: duration)
                        .padding(8)
                        .accessibilityLabel("Duration \(duration)")
                }
            }
            .overlay(alignment: .topLeading) {
                if showsBadges, cap.isProtected {
                    GlassBadge(text: "Protected", systemImage: "lock.fill")
                        .padding(8)
                }
            }
            .overlay {
                if let upload = cap.upload, cap.isProcessing || upload.phase == .error {
                    UploadProgressOverlay(progress: upload)
                }
            }
            .clipShape(.rect(cornerRadius: cornerRadius, style: .continuous))
            .contentShape(.rect(cornerRadius: cornerRadius, style: .continuous))
    }
}

struct ThumbnailPlaceholder: View {
    var isProcessing = false

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [CapTheme.blueSoft.opacity(0.55), CapTheme.blue.opacity(0.25)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            if !isProcessing {
                Image(systemName: "play.rectangle.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(.white.opacity(0.85))
            }
        }
    }
}

struct UploadProgressOverlay: View {
    let progress: UploadProgress

    var body: some View {
        ZStack {
            Rectangle().fill(.black.opacity(0.35))
            VStack(spacing: 10) {
                if progress.phase == .error {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.title2)
                        .foregroundStyle(.yellow)
                } else {
                    ProgressView(value: progress.fractionCompleted)
                        .progressViewStyle(.circular)
                        .tint(.white)
                        .controlSize(.large)
                }
                Text(progress.statusText)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 12)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct CapEnvironmentKey: EnvironmentKey {
    static let defaultValue = CapEnvironment.production
}

extension EnvironmentValues {
    var capEnvironment: CapEnvironment {
        get { self[CapEnvironmentKey.self] }
        set { self[CapEnvironmentKey.self] = newValue }
    }
}
