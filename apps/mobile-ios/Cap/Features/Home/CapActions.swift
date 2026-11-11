import CapKit
import SwiftUI
import UIKit

@MainActor
enum CapActions {
    static func copyLink(_ link: String, session: SessionModel) {
        guard let url = SafeURL.web(link) else { return }
        UIPasteboard.general.url = url
        session.toasts.show("Link copied", systemImage: "link")
    }

    @discardableResult
    static func setPublic(_ cap: CapSummary, isPublic: Bool, session: SessionModel) async -> CapSummary? {
        guard let id = CapID(cap.id) else { return nil }
        var optimistic = cap
        optimistic.isPublic = isPublic
        session.capChanged(optimistic)
        do {
            let updated = try await session.api.updateSharing(id, isPublic: isPublic)
            session.capChanged(updated)
            let restricted = updated.isPublic && updated.linkRestricted == true
            session.toasts.show(
                restricted ? "Only your organization's emails can view" : isPublic ? "Anyone with the link can view" : "Only you and your team can view",
                systemImage: isPublic ? "globe" : "lock.fill"
            )
            return updated
        } catch {
            session.capChanged(cap)
            session.toasts.show(error)
            return nil
        }
    }

    @discardableResult
    static func setLinkAccess(_ cap: CapSummary, linkAccess: LinkAccess, session: SessionModel) async -> CapSummary? {
        guard let id = CapID(cap.id), cap.isPublic else { return nil }
        var optimistic = cap
        optimistic.linkAccess = linkAccess
        session.capChanged(optimistic)
        do {
            let updated = try await session.api.updateSharing(id, isPublic: true, linkAccess: linkAccess)
            session.capChanged(updated)
            if updated.isPublic {
                session.toasts.show(
                    updated.linkRestricted == true ? "Only your organization's emails can view" : "Anyone with the link can view",
                    systemImage: updated.linkRestricted == true ? "person.2" : "globe"
                )
            }
            return updated
        } catch {
            session.capChanged(cap)
            session.toasts.show(error)
            return nil
        }
    }

    static func delete(_ cap: CapSummary, session: SessionModel) async -> Bool {
        guard let id = CapID(cap.id) else { return false }
        do {
            try await session.api.deleteCap(id)
            session.capDeleted(cap.id)
            session.toasts.show("Cap deleted", systemImage: "trash")
            return true
        } catch {
            session.toasts.show(error)
            return false
        }
    }
}

private struct CapContextMenu: ViewModifier {
    let cap: CapSummary
    @Binding var pendingDelete: CapSummary?
    @Environment(SessionModel.self) private var session

    func body(content: Content) -> some View {
        content.contextMenu {
            let owned = cap.isOwned(by: session.credentials.userId)
            Button("Copy link", systemImage: "link") {
                CapActions.copyLink(cap.shareUrl, session: session)
            }
            if let url = SafeURL.web(cap.shareUrl) {
                ShareLink(item: url, subject: Text(cap.title)) {
                    Label("Share", systemImage: "square.and.arrow.up")
                }
            }
            if owned {
                Divider()
                Button(cap.isPublic ? "Make private" : "Make public", systemImage: cap.isPublic ? "lock" : "globe") {
                    Task { await CapActions.setPublic(cap, isPublic: !cap.isPublic, session: session) }
                }
                Divider()
                Button("Delete", systemImage: "trash", role: .destructive) {
                    pendingDelete = cap
                }
            }
        } preview: {
            VStack(alignment: .leading, spacing: 10) {
                CapThumbnail(cap: cap, cornerRadius: 0)
                Text(cap.title)
                    .font(.headline)
                    .lineLimit(2)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 14)
            }
            .frame(width: 340)
            .environment(session)
        }
    }
}

private struct CapDeleteConfirmation: ViewModifier {
    @Binding var pendingDelete: CapSummary?
    var onDeleted: (CapSummary) -> Void = { _ in }
    @Environment(SessionModel.self) private var session

    func body(content: Content) -> some View {
        content.confirmationDialog(
            "Delete this Cap?",
            isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
            titleVisibility: .visible,
            presenting: pendingDelete
        ) { cap in
            Button("Delete Cap", role: .destructive) {
                Task {
                    if await CapActions.delete(cap, session: session) { onDeleted(cap) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { cap in
            Text("\u{201C}\(cap.title)\u{201D} will be permanently deleted for everyone, including its link, comments and analytics.")
        }
    }
}

extension View {
    func capContextMenu(cap: CapSummary, pendingDelete: Binding<CapSummary?>) -> some View {
        modifier(CapContextMenu(cap: cap, pendingDelete: pendingDelete))
    }

    func capDeleteConfirmation(pendingDelete: Binding<CapSummary?>, onDeleted: @escaping (CapSummary) -> Void = { _ in }) -> some View {
        modifier(CapDeleteConfirmation(pendingDelete: pendingDelete, onDeleted: onDeleted))
    }
}
