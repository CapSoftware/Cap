import CapKit
import SwiftUI

enum CapTheme {
    static let blue = Color("CapBlue")
    static let blueSoft = Color("CapBlueSoft")
    static let cardRadius: CGFloat = 22
    static let thumbnailRadius: CGFloat = 18
    static let controlRadius: CGFloat = 14
    static let spacing: CGFloat = 16

    static let brandGradient = LinearGradient(
        colors: [Color(red: 0.28, green: 0.52, blue: 1.0), Color(red: 0.16, green: 0.36, blue: 0.94)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
}

extension FolderColor {
    var tint: Color {
        switch self {
        case .normal: .secondary
        case .blue: .blue
        case .red: .red
        case .yellow: .yellow
        }
    }
}

struct CapLogoMark: View {
    var size: CGFloat = 44
    var animated = false
    @State private var breathe = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Image("CapLogo")
            .resizable()
            .interpolation(.high)
            .frame(width: size, height: size)
            .scaleEffect(breathe ? 1.03 : 1)
            .accessibilityElement()
            .accessibilityLabel("Cap")
            .onAppear {
                guard animated, !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 2.4).repeatForever(autoreverses: true)) {
                    breathe = true
                }
            }
    }
}

struct SectionHeader: View {
    let title: String
    var trailing: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(.title3.weight(.semibold))
            Spacer()
            if let trailing {
                Text(trailing)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
        .accessibilityAddTraits(.isHeader)
    }
}

struct GlassBadge: View {
    let text: String
    var systemImage: String?

    var body: some View {
        Label {
            Text(text).monospacedDigit()
        } icon: {
            if let systemImage { Image(systemName: systemImage) }
        }
        .labelStyle(BadgeLabelStyle(hasIcon: systemImage != nil))
        .font(.caption.weight(.semibold))
        .foregroundStyle(.white)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .glassEffect(.regular.tint(.black.opacity(0.25)), in: .capsule)
    }
}

private struct BadgeLabelStyle: LabelStyle {
    let hasIcon: Bool

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            if hasIcon { configuration.icon }
            configuration.title
        }
    }
}

struct StatLabel: View {
    let value: Int
    let systemImage: String
    let accessibilityNoun: String

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: systemImage)
                .imageScale(.small)
            Text(CapFormat.count(value))
                .monospacedDigit()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(value) \(accessibilityNoun)")
    }
}

struct PrimaryActionButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 52)
            .foregroundStyle(.white)
            .background(CapTheme.brandGradient, in: .rect(cornerRadius: CapTheme.controlRadius + 2))
            .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.45)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.snappy(duration: 0.18), value: configuration.isPressed)
    }
}

extension View {
    func capCardBackground() -> some View {
        background(.background.secondary, in: .rect(cornerRadius: CapTheme.cardRadius))
    }
}
