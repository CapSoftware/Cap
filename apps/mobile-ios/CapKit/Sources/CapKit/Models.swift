import Foundation

public enum MemberRole: String, UnknownCaseDecodable {
    case owner
    case admin
    case member

    public static let unknownCase = MemberRole.member

    public var canManage: Bool { self == .owner || self == .admin }

    public var displayName: String {
        switch self {
        case .owner: "Owner"
        case .admin: "Admin"
        case .member: "Member"
        }
    }
}

public enum PushEnvironment: String, Codable, Sendable {
    case sandbox, production
}

/// The same switches as cap.so's notification settings: they cover email and cap.so alerts.
public struct NotificationPreferences: Codable, Sendable, Hashable {
    public var comments: Bool
    public var replies: Bool
    public var views: Bool
    public var anonymousViews: Bool
    public var reactions: Bool

    public init(comments: Bool = true, replies: Bool = true, views: Bool = true, anonymousViews: Bool = true, reactions: Bool = true) {
        self.comments = comments
        self.replies = replies
        self.views = views
        self.anonymousViews = anonymousViews
        self.reactions = reactions
    }

    public enum Kind: String, CaseIterable, Sendable {
        case comments, replies, views, anonymousViews, reactions

        var keyPath: WritableKeyPath<NotificationPreferences, Bool> {
            switch self {
            case .comments: \.comments
            case .replies: \.replies
            case .views: \.views
            case .anonymousViews: \.anonymousViews
            case .reactions: \.reactions
            }
        }
    }

    public subscript(kind: Kind) -> Bool {
        get { self[keyPath: kind.keyPath] }
        set { self[keyPath: kind.keyPath] = newValue }
    }
}

public struct CapUser: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String?
    public let lastName: String?
    public let email: String
    public let imageUrl: String?
    public let activeOrganizationId: String

    public init(id: String, name: String?, lastName: String?, email: String, imageUrl: String?, activeOrganizationId: String) {
        self.id = id
        self.name = name
        self.lastName = lastName
        self.email = email
        self.imageUrl = imageUrl
        self.activeOrganizationId = activeOrganizationId
    }

    public var displayName: String {
        let full = [name, lastName]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        if !full.isEmpty { return full }
        return email.split(separator: "@").first.map(String.init) ?? email
    }
}

public struct Organization: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let iconUrl: String?
    public let role: MemberRole

    public init(id: String, name: String, iconUrl: String?, role: MemberRole) {
        self.id = id
        self.name = name
        self.iconUrl = iconUrl
        self.role = role
    }
}

public enum SpaceKind: String, UnknownCaseDecodable {
    case organization
    case space

    public static let unknownCase = SpaceKind.space
}

public enum SpacePrivacy: String, UnknownCaseDecodable {
    case isPublic = "Public"
    case isPrivate = "Private"

    public static let unknownCase = SpacePrivacy.isPrivate
}

public struct Space: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let iconUrl: String?
    public let kind: SpaceKind
    public let privacy: SpacePrivacy
    public let role: MemberRole?
    public let canManage: Bool
    public let hasPassword: Bool

    public init(id: String, name: String, iconUrl: String?, kind: SpaceKind, privacy: SpacePrivacy, role: MemberRole?, canManage: Bool, hasPassword: Bool) {
        self.id = id
        self.name = name
        self.iconUrl = iconUrl
        self.kind = kind
        self.privacy = privacy
        self.role = role
        self.canManage = canManage
        self.hasPassword = hasPassword
    }
}

public enum FolderColor: String, UnknownCaseDecodable, CaseIterable {
    case normal
    case blue
    case red
    case yellow

    public static let unknownCase = FolderColor.normal

    public var displayName: String {
        switch self {
        case .normal: "Default"
        case .blue: "Blue"
        case .red: "Red"
        case .yellow: "Yellow"
        }
    }
}

public struct Folder: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let color: FolderColor
    public let parentId: String?
    public let videoCount: Int

    public init(id: String, name: String, color: FolderColor, parentId: String?, videoCount: Int) {
        self.id = id
        self.name = name
        self.color = color
        self.parentId = parentId
        self.videoCount = videoCount
    }

    enum CodingKeys: String, CodingKey {
        case id, name, color, parentId, videoCount
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        color = (try? container.decode(FolderColor.self, forKey: .color)) ?? .normal
        parentId = try container.decodeIfPresent(String.self, forKey: .parentId)
        videoCount = (try? container.decodeCount(forKey: .videoCount)) ?? 0
    }
}

public enum UploadPhase: String, UnknownCaseDecodable {
    case uploading
    case processing
    case generatingThumbnail = "generating_thumbnail"
    case complete
    case error

    public static let unknownCase = UploadPhase.processing
}

public struct UploadProgress: Codable, Sendable, Hashable {
    public let uploaded: Double
    public let total: Double
    public let phase: UploadPhase
    public let processingProgress: Double
    public let processingMessage: String?
    public let processingError: String?

    public init(uploaded: Double, total: Double, phase: UploadPhase, processingProgress: Double, processingMessage: String?, processingError: String?) {
        self.uploaded = uploaded
        self.total = total
        self.phase = phase
        self.processingProgress = processingProgress
        self.processingMessage = processingMessage
        self.processingError = processingError
    }

    enum CodingKeys: String, CodingKey {
        case uploaded, total, phase, processingProgress, processingMessage, processingError
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        uploaded = (try? container.decodeNumber(forKey: .uploaded)) ?? 0
        total = (try? container.decodeNumber(forKey: .total)) ?? 0
        phase = (try? container.decode(UploadPhase.self, forKey: .phase)) ?? .processing
        processingProgress = (try? container.decodeNumber(forKey: .processingProgress)) ?? 0
        processingMessage = try container.decodeIfPresent(String.self, forKey: .processingMessage)
        processingError = try container.decodeIfPresent(String.self, forKey: .processingError)
    }

    public var fractionCompleted: Double {
        switch phase {
        case .uploading:
            guard total > 0 else { return 0 }
            return min(1, max(0, uploaded / total))
        case .processing, .generatingThumbnail:
            return min(1, max(0, processingProgress / 100))
        case .complete:
            return 1
        case .error:
            return 0
        }
    }

    public var statusText: String {
        switch phase {
        case .uploading: "Uploading"
        case .processing: processingMessage ?? "Processing"
        case .generatingThumbnail: "Generating thumbnail"
        case .complete: "Ready"
        // Server errors are internal details (stack names, config keys), never user copy.
        case .error: "Processing failed"
        }
    }
}

public enum LinkAccess: String, Codable, Sendable, Hashable {
    case anyone
    case restricted
}

public struct CapSummary: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let shareUrl: String
    public var title: String
    public let createdAt: Date
    public let updatedAt: Date
    public let ownerId: String?
    public let ownerName: String
    public let durationSeconds: Double?
    public let thumbnailUrl: String?
    public let thumbnailCacheKey: String?
    public let folderId: String?
    public var isPublic: Bool
    public var isProtected: Bool
    public let viewCount: Int
    public let commentCount: Int
    public let reactionCount: Int
    public var upload: UploadProgress?
    public let ownedByCurrentUser: Bool?
    public var linkAccess: LinkAccess?
    public var linkRestricted: Bool?

    public init(
        id: String,
        shareUrl: String,
        title: String,
        createdAt: Date,
        updatedAt: Date,
        ownerId: String?,
        ownerName: String,
        durationSeconds: Double?,
        thumbnailUrl: String?,
        thumbnailCacheKey: String?,
        folderId: String?,
        isPublic: Bool,
        isProtected: Bool,
        viewCount: Int,
        commentCount: Int,
        reactionCount: Int,
        upload: UploadProgress?,
        ownedByCurrentUser: Bool?,
        linkAccess: LinkAccess? = nil,
        linkRestricted: Bool? = nil
    ) {
        self.id = id
        self.shareUrl = shareUrl
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.ownerId = ownerId
        self.ownerName = ownerName
        self.durationSeconds = durationSeconds
        self.thumbnailUrl = thumbnailUrl
        self.thumbnailCacheKey = thumbnailCacheKey
        self.folderId = folderId
        self.isPublic = isPublic
        self.isProtected = isProtected
        self.viewCount = viewCount
        self.commentCount = commentCount
        self.reactionCount = reactionCount
        self.upload = upload
        self.ownedByCurrentUser = ownedByCurrentUser
        self.linkAccess = linkAccess
        self.linkRestricted = linkRestricted
    }

    enum CodingKeys: String, CodingKey {
        case id, shareUrl, title, createdAt, updatedAt, ownerId, ownerName, durationSeconds
        case thumbnailUrl, thumbnailCacheKey, folderId
        case isPublic = "public"
        case isProtected = "protected"
        case viewCount, commentCount, reactionCount, upload, ownedByCurrentUser, linkAccess, linkRestricted
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        shareUrl = try container.decode(String.self, forKey: .shareUrl)
        title = try container.decode(String.self, forKey: .title)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
        ownerId = try container.decodeIfPresent(String.self, forKey: .ownerId)
        ownerName = (try container.decodeIfPresent(String.self, forKey: .ownerName)) ?? ""
        durationSeconds = try? container.decodeNumber(forKey: .durationSeconds)
        thumbnailUrl = try container.decodeIfPresent(String.self, forKey: .thumbnailUrl)
        thumbnailCacheKey = try container.decodeIfPresent(String.self, forKey: .thumbnailCacheKey)
        folderId = try container.decodeIfPresent(String.self, forKey: .folderId)
        isPublic = try container.decode(Bool.self, forKey: .isPublic)
        isProtected = (try container.decodeIfPresent(Bool.self, forKey: .isProtected)) ?? false
        viewCount = (try? container.decodeCount(forKey: .viewCount)) ?? 0
        commentCount = (try? container.decodeCount(forKey: .commentCount)) ?? 0
        reactionCount = (try? container.decodeCount(forKey: .reactionCount)) ?? 0
        upload = try? container.decodeIfPresent(UploadProgress.self, forKey: .upload)
        ownedByCurrentUser = try container.decodeIfPresent(Bool.self, forKey: .ownedByCurrentUser)
        linkAccess = try? container.decodeIfPresent(LinkAccess.self, forKey: .linkAccess)
        linkRestricted = try? container.decodeIfPresent(Bool.self, forKey: .linkRestricted)
    }

    public func isOwned(by userId: String?) -> Bool {
        if let ownedByCurrentUser { return ownedByCurrentUser }
        guard let userId, let ownerId else { return false }
        return ownerId == userId
    }

    public var isProcessing: Bool {
        guard let upload else { return false }
        return upload.phase != .complete && upload.phase != .error
    }
}

public enum CommentKind: String, UnknownCaseDecodable {
    case text
    case emoji

    public static let unknownCase = CommentKind.text
}

public struct CommentAuthor: Codable, Sendable, Hashable {
    public let id: String
    public let name: String?
    public let imageUrl: String?

    public init(id: String, name: String?, imageUrl: String?) {
        self.id = id
        self.name = name
        self.imageUrl = imageUrl
    }
}

public struct CapComment: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let videoId: String
    public let type: CommentKind
    public let content: String
    public let timestamp: Double?
    public let parentCommentId: String?
    public let createdAt: Date
    public let updatedAt: Date
    public let author: CommentAuthor

    public init(id: String, videoId: String, type: CommentKind, content: String, timestamp: Double?, parentCommentId: String?, createdAt: Date, updatedAt: Date, author: CommentAuthor) {
        self.id = id
        self.videoId = videoId
        self.type = type
        self.content = content
        self.timestamp = timestamp
        self.parentCommentId = parentCommentId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.author = author
    }
}

public struct Chapter: Codable, Sendable, Hashable {
    public let title: String
    public let start: Double

    public init(title: String, start: Double) {
        self.title = title
        self.start = start
    }
}

public enum TranscriptionStatus: String, UnknownCaseDecodable {
    case processing = "PROCESSING"
    case complete = "COMPLETE"
    case error = "ERROR"
    case skipped = "SKIPPED"
    case noAudio = "NO_AUDIO"

    public static let unknownCase = TranscriptionStatus.skipped
}

/// Resolved by the server across the Cap, its organization and its spaces.
public struct ViewerSettings: Codable, Sendable, Hashable {
    public var disableSummary: Bool
    public var disableCaptions: Bool
    public var disableChapters: Bool
    public var disableReactions: Bool
    public var disableTranscript: Bool
    public var disableComments: Bool

    public init(disableSummary: Bool = false, disableCaptions: Bool = false, disableChapters: Bool = false, disableReactions: Bool = false, disableTranscript: Bool = false, disableComments: Bool = false) {
        self.disableSummary = disableSummary
        self.disableCaptions = disableCaptions
        self.disableChapters = disableChapters
        self.disableReactions = disableReactions
        self.disableTranscript = disableTranscript
        self.disableComments = disableComments
    }

    enum CodingKeys: String, CodingKey {
        case disableSummary, disableCaptions, disableChapters, disableReactions, disableTranscript, disableComments
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        func flag(_ key: CodingKeys) -> Bool { (try? container.decodeIfPresent(Bool.self, forKey: key)) ?? false }
        disableSummary = flag(.disableSummary)
        disableCaptions = flag(.disableCaptions)
        disableChapters = flag(.disableChapters)
        disableReactions = flag(.disableReactions)
        disableTranscript = flag(.disableTranscript)
        disableComments = flag(.disableComments)
    }
}

public struct CapViewer: Codable, Sendable, Hashable {
    public static let playbackSpeeds: [Float] = [0.5, 0.75, 1, 1.2, 1.5, 1.75, 2]

    public var settings: ViewerSettings
    public var defaultPlaybackSpeed: Float
    public var canDownload: Bool
    public var isScreenshot: Bool
    public var overShareLimit: Bool
    public var ownerImageUrl: String?
    public var aiGenerationStatus: String?

    public init(settings: ViewerSettings = ViewerSettings(), defaultPlaybackSpeed: Float = 1.2, canDownload: Bool = false, isScreenshot: Bool = false, overShareLimit: Bool = false, ownerImageUrl: String? = nil, aiGenerationStatus: String? = nil) {
        self.settings = settings
        self.defaultPlaybackSpeed = defaultPlaybackSpeed
        self.canDownload = canDownload
        self.isScreenshot = isScreenshot
        self.overShareLimit = overShareLimit
        self.ownerImageUrl = ownerImageUrl
        self.aiGenerationStatus = aiGenerationStatus
    }

    enum CodingKeys: String, CodingKey {
        case settings, defaultPlaybackSpeed, canDownload, isScreenshot, overShareLimit, ownerImageUrl, aiGenerationStatus
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        settings = (try? container.decodeIfPresent(ViewerSettings.self, forKey: .settings)) ?? ViewerSettings()
        let speed = (try? container.decodeIfPresent(Double.self, forKey: .defaultPlaybackSpeed)) ?? 1.2
        defaultPlaybackSpeed = Self.nearestSpeed(to: speed)
        canDownload = (try? container.decodeIfPresent(Bool.self, forKey: .canDownload)) ?? false
        isScreenshot = (try? container.decodeIfPresent(Bool.self, forKey: .isScreenshot)) ?? false
        overShareLimit = (try? container.decodeIfPresent(Bool.self, forKey: .overShareLimit)) ?? false
        ownerImageUrl = try? container.decodeIfPresent(String.self, forKey: .ownerImageUrl)
        aiGenerationStatus = try? container.decodeIfPresent(String.self, forKey: .aiGenerationStatus)
    }

    /// Snaps to the share page's speed list so a bad value can't play at 0x or 100x.
    public static func nearestSpeed(to value: Double) -> Float {
        guard value.isFinite, value > 0 else { return 1.2 }
        return playbackSpeeds.min { abs(Double($0) - value) < abs(Double($1) - value) } ?? 1.2
    }

    public var isGeneratingAI: Bool {
        aiGenerationStatus == "QUEUED" || aiGenerationStatus == "PROCESSING"
    }
}

public enum CapAccessStatus: String, UnknownCaseDecodable {
    case granted
    case passwordRequired = "password_required"
    case restricted
    case unknown

    public static let unknownCase = CapAccessStatus.unknown
}

struct CapAccessResponse: Decodable {
    let status: CapAccessStatus
}

public struct CapUnlock: Codable, Sendable, Hashable {
    public let accessToken: String
    public let expiresAt: Date
}

public struct CapDetail: Codable, Sendable, Hashable {
    public var cap: CapSummary
    public let summary: String?
    public let chapters: [Chapter]
    public let transcriptionStatus: TranscriptionStatus?
    public var comments: [CapComment]
    public let shareUrl: String
    public var viewer: CapViewer

    public init(cap: CapSummary, summary: String?, chapters: [Chapter], transcriptionStatus: TranscriptionStatus?, comments: [CapComment], shareUrl: String, viewer: CapViewer = CapViewer()) {
        self.cap = cap
        self.summary = summary
        self.chapters = chapters
        self.transcriptionStatus = transcriptionStatus
        self.comments = comments
        self.shareUrl = shareUrl
        self.viewer = viewer
    }

    enum CodingKeys: String, CodingKey {
        case cap, summary, chapters, transcriptionStatus, comments, shareUrl, viewer
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        cap = try container.decode(CapSummary.self, forKey: .cap)
        summary = try container.decodeIfPresent(String.self, forKey: .summary)
        chapters = try container.decodeLossyArray(Chapter.self, forKey: .chapters)
        transcriptionStatus = try? container.decodeIfPresent(TranscriptionStatus.self, forKey: .transcriptionStatus)
        comments = try container.decodeLossyArray(CapComment.self, forKey: .comments)
        shareUrl = try container.decode(String.self, forKey: .shareUrl)
        viewer = (try? container.decodeIfPresent(CapViewer.self, forKey: .viewer)) ?? CapViewer()
    }
}

public struct CapsPage: Codable, Sendable, Hashable {
    public let folders: [Folder]
    public let caps: [CapSummary]
    public let page: Int
    public let limit: Int
    public let total: Int
    public let collectionTotal: Int?
    public let hasMore: Bool

    public init(folders: [Folder], caps: [CapSummary], page: Int, limit: Int, total: Int, collectionTotal: Int?, hasMore: Bool) {
        self.folders = folders
        self.caps = caps
        self.page = page
        self.limit = limit
        self.total = total
        self.collectionTotal = collectionTotal
        self.hasMore = hasMore
    }

    enum CodingKeys: String, CodingKey {
        case folders, caps, page, limit, total, collectionTotal, hasMore
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        folders = try container.decodeLossyArray(Folder.self, forKey: .folders)
        caps = try container.decodeLossyArray(CapSummary.self, forKey: .caps)
        page = try container.decodeCount(forKey: .page)
        limit = try container.decodeCount(forKey: .limit)
        total = try container.decodeCount(forKey: .total)
        collectionTotal = try? container.decodeCount(forKey: .collectionTotal)
        hasMore = try container.decode(Bool.self, forKey: .hasMore)
    }
}

public struct CapStatus: Codable, Sendable, Hashable {
    public let id: String
    public let upload: UploadProgress?
}

public struct CapStatusesResponse: Codable, Sendable, Hashable {
    public let caps: [CapStatus]
}

public struct Bootstrap: Codable, Sendable, Hashable {
    public var user: CapUser
    public let organizations: [Organization]
    public let activeOrganizationId: String?
    public let rootFolders: [Folder]
    public let spaces: [Space]

    public init(user: CapUser, organizations: [Organization], activeOrganizationId: String?, rootFolders: [Folder], spaces: [Space]) {
        self.user = user
        self.organizations = organizations
        self.activeOrganizationId = activeOrganizationId
        self.rootFolders = rootFolders
        self.spaces = spaces
    }

    enum CodingKeys: String, CodingKey {
        case user, organizations, activeOrganizationId, rootFolders, spaces
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        user = try container.decode(CapUser.self, forKey: .user)
        organizations = try container.decodeLossyArray(Organization.self, forKey: .organizations)
        activeOrganizationId = try container.decodeIfPresent(String.self, forKey: .activeOrganizationId)
        rootFolders = try container.decodeLossyArray(Folder.self, forKey: .rootFolders)
        spaces = try container.decodeLossyArray(Space.self, forKey: .spaces)
    }

    public var activeOrganization: Organization? {
        let id = activeOrganizationId ?? user.activeOrganizationId
        return organizations.first { $0.id == id }
    }
}

public enum PlaybackKind: String, UnknownCaseDecodable {
    case mp4
    case hls

    public static let unknownCase = PlaybackKind.mp4
}

public struct Playback: Codable, Sendable, Hashable {
    public let kind: PlaybackKind
    public let url: String
    public let transcriptUrl: String?

    public init(kind: PlaybackKind, url: String, transcriptUrl: String?) {
        self.kind = kind
        self.url = url
        self.transcriptUrl = transcriptUrl
    }
}

public struct DownloadLink: Codable, Sendable, Hashable {
    public let fileName: String
    public let url: String
}

public enum AnalyticsRange: String, Codable, Sendable, CaseIterable, Identifiable {
    case day = "24h"
    case week = "7d"
    case month = "30d"
    case lifetime

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .day: "24H"
        case .week: "7D"
        case .month: "30D"
        case .lifetime: "All"
        }
    }

    public var accessibilityTitle: String {
        switch self {
        case .day: "Last 24 hours"
        case .week: "Last 7 days"
        case .month: "Last 30 days"
        case .lifetime: "All time"
        }
    }

    public var usesHourlyBuckets: Bool { self == .day }
}

public struct AnalyticsBreakdown: Codable, Sendable, Hashable, Identifiable {
    public let name: String
    public let subtitle: String?
    public let views: Int
    public let percentage: Double
    public let capId: String?

    public var id: String { [capId ?? "", name, subtitle ?? ""].joined(separator: "|") }

    public init(name: String, subtitle: String?, views: Int, percentage: Double, capId: String? = nil) {
        self.name = name
        self.subtitle = subtitle
        self.views = views
        self.percentage = percentage
        self.capId = capId
    }

    enum CodingKeys: String, CodingKey {
        case name, subtitle, views, percentage
        case capId = "id"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        subtitle = try container.decodeIfPresent(String.self, forKey: .subtitle)
        views = (try? container.decodeCount(forKey: .views)) ?? 0
        percentage = (try? container.decodeNumber(forKey: .percentage)) ?? 0
        capId = try container.decodeIfPresent(String.self, forKey: .capId)
    }
}

public struct AnalyticsCounts: Codable, Sendable, Hashable {
    public let caps: Int
    public let views: Int
    public let comments: Int
    public let reactions: Int

    public init(caps: Int, views: Int, comments: Int, reactions: Int) {
        self.caps = caps
        self.views = views
        self.comments = comments
        self.reactions = reactions
    }

    enum CodingKeys: String, CodingKey {
        case caps, views, comments, reactions
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        caps = (try? container.decodeCount(forKey: .caps)) ?? 0
        views = (try? container.decodeCount(forKey: .views)) ?? 0
        comments = (try? container.decodeCount(forKey: .comments)) ?? 0
        reactions = (try? container.decodeCount(forKey: .reactions)) ?? 0
    }
}

public struct AnalyticsPoint: Codable, Sendable, Hashable, Identifiable {
    public let bucket: String
    public let date: Date?
    public let caps: Int
    public let views: Int
    public let comments: Int
    public let reactions: Int

    public var id: String { bucket }

    public init(bucket: String, caps: Int, views: Int, comments: Int, reactions: Int) {
        self.bucket = bucket
        self.date = CapJSON.parseDate(bucket)
        self.caps = caps
        self.views = views
        self.comments = comments
        self.reactions = reactions
    }

    enum CodingKeys: String, CodingKey {
        case bucket, caps, views, comments, reactions
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        bucket = try container.decode(String.self, forKey: .bucket)
        date = CapJSON.parseDate(bucket)
        caps = (try? container.decodeCount(forKey: .caps)) ?? 0
        views = (try? container.decodeCount(forKey: .views)) ?? 0
        comments = (try? container.decodeCount(forKey: .comments)) ?? 0
        reactions = (try? container.decodeCount(forKey: .reactions)) ?? 0
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(bucket, forKey: .bucket)
        try container.encode(caps, forKey: .caps)
        try container.encode(views, forKey: .views)
        try container.encode(comments, forKey: .comments)
        try container.encode(reactions, forKey: .reactions)
    }
}

public struct AnalyticsBreakdowns: Codable, Sendable, Hashable {
    public let countries: [AnalyticsBreakdown]
    public let cities: [AnalyticsBreakdown]
    public let browsers: [AnalyticsBreakdown]
    public let operatingSystems: [AnalyticsBreakdown]
    public let devices: [AnalyticsBreakdown]
    public let topCaps: [AnalyticsBreakdown]

    public init(countries: [AnalyticsBreakdown], cities: [AnalyticsBreakdown], browsers: [AnalyticsBreakdown], operatingSystems: [AnalyticsBreakdown], devices: [AnalyticsBreakdown], topCaps: [AnalyticsBreakdown]) {
        self.countries = countries
        self.cities = cities
        self.browsers = browsers
        self.operatingSystems = operatingSystems
        self.devices = devices
        self.topCaps = topCaps
    }

    enum CodingKeys: String, CodingKey {
        case countries, cities, browsers, operatingSystems, devices, topCaps
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        countries = try container.decodeLossyArray(AnalyticsBreakdown.self, forKey: .countries)
        cities = try container.decodeLossyArray(AnalyticsBreakdown.self, forKey: .cities)
        browsers = try container.decodeLossyArray(AnalyticsBreakdown.self, forKey: .browsers)
        operatingSystems = try container.decodeLossyArray(AnalyticsBreakdown.self, forKey: .operatingSystems)
        devices = try container.decodeLossyArray(AnalyticsBreakdown.self, forKey: .devices)
        topCaps = try container.decodeLossyArray(AnalyticsBreakdown.self, forKey: .topCaps)
    }
}

public struct AnalyticsData: Codable, Sendable, Hashable {
    public let capName: String?
    public let counts: AnalyticsCounts
    public let chart: [AnalyticsPoint]
    public let breakdowns: AnalyticsBreakdowns

    public init(capName: String?, counts: AnalyticsCounts, chart: [AnalyticsPoint], breakdowns: AnalyticsBreakdowns) {
        self.capName = capName
        self.counts = counts
        self.chart = chart
        self.breakdowns = breakdowns
    }

    enum CodingKeys: String, CodingKey {
        case capName, counts, chart, breakdowns
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        capName = try container.decodeIfPresent(String.self, forKey: .capName)
        counts = try container.decode(AnalyticsCounts.self, forKey: .counts)
        chart = try container.decodeLossyArray(AnalyticsPoint.self, forKey: .chart)
        breakdowns = try container.decode(AnalyticsBreakdowns.self, forKey: .breakdowns)
    }
}

public struct AnalyticsResponse: Codable, Sendable, Hashable {
    public let available: Bool
    public let data: AnalyticsData?

    public init(available: Bool, data: AnalyticsData?) {
        self.available = available
        self.data = data
    }
}

public struct OrganizationSettings: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let role: MemberRole
    public let canManage: Bool
    public let iconUrl: String?
    public let allowedEmailDomain: String?
    public let customDomain: String?
    public let domainVerified: Bool

    public init(id: String, name: String, role: MemberRole, canManage: Bool, iconUrl: String?, allowedEmailDomain: String?, customDomain: String?, domainVerified: Bool) {
        self.id = id
        self.name = name
        self.role = role
        self.canManage = canManage
        self.iconUrl = iconUrl
        self.allowedEmailDomain = allowedEmailDomain
        self.customDomain = customDomain
        self.domainVerified = domainVerified
    }
}

public struct LoomImportResult: Codable, Sendable, Hashable {
    public let id: String
    public let shareUrl: String
}

public enum UploadTarget: Codable, Sendable, Hashable {
    case s3Post(url: String, fields: [String: String])
    case put(url: String, headers: [String: String])
    case driveResumable(url: String, headers: [String: String])

    enum CodingKeys: String, CodingKey {
        case type, url, fields, headers
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        let url = try container.decode(String.self, forKey: .url)
        switch type {
        case "s3Post":
            self = .s3Post(url: url, fields: try container.decode([String: String].self, forKey: .fields))
        case "put":
            self = .put(url: url, headers: try container.decode([String: String].self, forKey: .headers))
        case "driveResumable":
            self = .driveResumable(url: url, headers: try container.decode([String: String].self, forKey: .headers))
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: container, debugDescription: "Unsupported upload target")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .s3Post(url, fields):
            try container.encode("s3Post", forKey: .type)
            try container.encode(url, forKey: .url)
            try container.encode(fields, forKey: .fields)
        case let .put(url, headers):
            try container.encode("put", forKey: .type)
            try container.encode(url, forKey: .url)
            try container.encode(headers, forKey: .headers)
        case let .driveResumable(url, headers):
            try container.encode("driveResumable", forKey: .type)
            try container.encode(url, forKey: .url)
            try container.encode(headers, forKey: .headers)
        }
    }

    public var url: String {
        switch self {
        case let .s3Post(url, _), let .put(url, _), let .driveResumable(url, _): url
        }
    }
}

public struct UploadCreated: Codable, Sendable, Hashable {
    public let id: String
    public let shareUrl: String
    public let rawFileKey: String
    public let upload: UploadTarget
}

public struct APIKeySession: Codable, Sendable, Hashable {
    public let apiKey: String
    public let userId: String

    public init(apiKey: String, userId: String) {
        self.apiKey = apiKey
        self.userId = userId
    }
}

public struct AuthConfig: Codable, Sendable, Hashable {
    public let appleAuthAvailable: Bool
    public let googleAuthAvailable: Bool
    public let workosAuthAvailable: Bool

    public init(appleAuthAvailable: Bool, googleAuthAvailable: Bool, workosAuthAvailable: Bool) {
        self.appleAuthAvailable = appleAuthAvailable
        self.googleAuthAvailable = googleAuthAvailable
        self.workosAuthAvailable = workosAuthAvailable
    }

    public static let fallback = AuthConfig(appleAuthAvailable: true, googleAuthAvailable: true, workosAuthAvailable: true)
}

public struct PlanStatus: Codable, Sendable, Hashable {
    public let upgraded: Bool
    public let stripeSubscriptionStatus: String?

    public init(upgraded: Bool, stripeSubscriptionStatus: String?) {
        self.upgraded = upgraded
        self.stripeSubscriptionStatus = stripeSubscriptionStatus
    }
}

public enum ContentReportReason: String, Codable, Sendable, CaseIterable, Identifiable {
    case harassment
    case hate
    case sexual
    case violence
    case copyright
    case other

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .harassment: "Harassment or bullying"
        case .hate: "Hate speech"
        case .sexual: "Sexual content"
        case .violence: "Violence or threats"
        case .copyright: "Copyright infringement"
        case .other: "Other concern"
        }
    }
}
