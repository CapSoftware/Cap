import CapKit
import SwiftUI

struct StudioEditorCover: View {
    let project: StudioProject
    let session: SessionModel
    @State private var model: EditorModel

    init(project: StudioProject, session: SessionModel) {
        self.project = project
        self.session = session
        _model = State(initialValue: EditorModel(project: project, session: session))
    }

    var body: some View {
        EditorView(model: model) { _ in
            StudioSession.shared.editing = nil
            StudioSession.shared.reload()
        }
        .environment(session)
    }
}

struct StudioDrafts: View {
    let studio: StudioSession
    @State private var deleting: StudioProject?

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 10) {
                ForEach(studio.projects) { project in
                    Button {
                        studio.editing = project
                    } label: {
                        StudioDraftCard(project: project, studio: studio)
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button("Delete", systemImage: "trash", role: .destructive) { deleting = project }
                    }
                    .accessibilityLabel("\(project.title), \(CapFormat.timestamp(project.timeline.outputDuration))")
                    .accessibilityHint("Opens the editor")
                    .accessibilityAction(named: "Delete") { deleting = project }
                }
            }
            .padding(.horizontal, 16)
        }
        .scrollIndicators(.hidden)
        .frame(height: StudioDraftCard.height)
        .confirmationDialog("Delete this recording?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let deleting { studio.delete(deleting) }
                deleting = nil
            }
            Button("Cancel", role: .cancel) { deleting = nil }
        } message: {
            Text("It's only on this iPhone, so it can't be recovered.")
        }
        .accessibilityIdentifier("studio-drafts")
    }
}

private struct StudioDraftCard: View {
    static let height: CGFloat = 112
    let project: StudioProject
    let studio: StudioSession
    @State private var image: UIImage?

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Color.white.opacity(0.1)
            }
            LinearGradient(colors: [.clear, .black.opacity(0.65)], startPoint: .center, endPoint: .bottom)
            HStack(spacing: 4) {
                Image(systemName: project.screen != nil ? (project.camera != nil ? "rectangle.inset.bottomright.filled" : "iphone") : "person.crop.square")
                    .font(.caption2.weight(.semibold))
                Text(CapFormat.timestamp(project.timeline.outputDuration))
                    .font(.caption.weight(.semibold).monospacedDigit())
            }
            .padding(8)
        }
        .frame(width: 76, height: Self.height)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(.white.opacity(0.15), lineWidth: 1))
        .task(id: project.id) { image = await studio.thumbnail(for: project) }
    }
}
