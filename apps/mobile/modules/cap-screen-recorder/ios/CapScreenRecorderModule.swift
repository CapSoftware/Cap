import ExpoModulesCore
import ReplayKit

private func bridgeValue<T>(_ value: T?) -> Any {
  if let value {
    return value
  }
  return NSNull()
}

private final class ScreenRecorderException:
  Exception,
  @unchecked Sendable
{
  private let message: String

  init(_ message: String) {
    self.message = message
    super.init()
  }

  override var reason: String {
    message
  }
}

private struct PrepareScreenRecordingOptions: Record {
  @Field var recordingId = ""
  @Field var width = 720
  @Field var height = 1280
  @Field var videoBitrate = 1_800_000
  @Field var segmentDurationSeconds = 2.0
  @Field var maximumDurationSeconds: Double?
}

private struct ScreenRecordingConfiguration: Codable {
  let recordingId: String
  let width: Int
  let height: Int
  let videoBitrate: Int
  let segmentDurationSeconds: Double
  let maximumDurationSeconds: Double?
  let createdAt: Date
}

private struct ScreenRecordingSegment: Codable {
  let track: String
  let type: String
  let index: Int
  let uri: String
  let durationSeconds: Double
  let byteLength: Int
}

private struct ScreenRecordingManifest: Codable {
  let recordingId: String
  var status: String
  var segments: [ScreenRecordingSegment]
  var durationSeconds: Double?
  var totalBytes: Int
  var error: String?
  var uploadStartedAt: Date?
}

public final class CapScreenRecorderModule: Module {
  private static let staleRecordingInterval: TimeInterval = 15
  private static let stalePreparedInterval: TimeInterval = 10 * 60
  private static let staleUploadInterval: TimeInterval = 30

  public func definition() -> ModuleDefinition {
    Name("CapScreenRecorder")

    View(CapScreenRecorderView.self) {
      Prop("enabled") { (view, enabled: Bool?) in
        view.enabled = enabled ?? true
      }
    }

    AsyncFunction("getAvailability") {
      #if targetEnvironment(simulator)
      return [
        "available": false,
        "minimumSystemVersion": "15.1",
        "reason": "Screen recording requires a physical iPhone."
      ]
      #else
      let available = RPScreenRecorder.shared().isAvailable
      let reason: String? = available
        ? nil
        : "Screen recording is currently unavailable on this iPhone."
      return [
        "available": available,
        "minimumSystemVersion": "15.1",
        "reason": bridgeValue(reason)
      ]
      #endif
    }

    AsyncFunction("prepareRecording") {
      (options: PrepareScreenRecordingOptions) in
      try self.prepareRecording(options)
    }

    AsyncFunction("getRecordingUpdates") { (recordingId: String) in
      try self.getRecordingUpdates(recordingId)
    }

    AsyncFunction("cancelRecording") { (recordingId: String) in
      try self.cancelRecording(recordingId)
    }
  }

  private func prepareRecording(
    _ options: PrepareScreenRecordingOptions
  ) throws {
    try validateRecordingId(options.recordingId)
    #if targetEnvironment(simulator)
    throw ScreenRecorderException(
      "Screen recording requires a physical iPhone."
    )
    #else
    guard RPScreenRecorder.shared().isAvailable else {
      throw ScreenRecorderException(
        "Screen recording is currently unavailable on this iPhone."
      )
    }
    #endif

    let maximumDurationIsValid =
      options.maximumDurationSeconds == nil ||
      (
        options.maximumDurationSeconds?.isFinite == true &&
        (options.maximumDurationSeconds ?? 0) > 0
      )
    guard options.width >= 320,
          options.width <= 1920,
          options.height >= 320,
          options.height <= 1920,
          options.videoBitrate >= 800_000,
          options.videoBitrate <= 4_000_000,
          options.segmentDurationSeconds >= 1,
          options.segmentDurationSeconds <= 6,
          maximumDurationIsValid
    else {
      throw ScreenRecorderException(
        "Cap received an invalid screen recording configuration."
      )
    }

    let root = try recordingsRoot()
    try recoverExistingConfiguration(recordingsRoot: root)
    let recordingDirectory = root.appendingPathComponent(
      options.recordingId,
      isDirectory: true
    )
    if FileManager.default.fileExists(atPath: recordingDirectory.path) {
      try FileManager.default.removeItem(at: recordingDirectory)
    }
    try FileManager.default.createDirectory(
      at: recordingDirectory,
      withIntermediateDirectories: true
    )
    try excludeFromBackup(recordingDirectory)

    let configuration = ScreenRecordingConfiguration(
      recordingId: options.recordingId,
      width: options.width,
      height: options.height,
      videoBitrate: options.videoBitrate,
      segmentDurationSeconds: options.segmentDurationSeconds,
      maximumDurationSeconds: options.maximumDurationSeconds,
      createdAt: Date()
    )
    let manifest = ScreenRecordingManifest(
      recordingId: options.recordingId,
      status: "prepared",
      segments: [],
      durationSeconds: nil,
      totalBytes: 0,
      error: nil,
      uploadStartedAt: nil
    )
    try encode(
      manifest,
      to: manifestURL(
        recordingsRoot: root,
        recordingId: options.recordingId
      )
    )
    try encode(configuration, to: activeConfigurationURL(root))
  }

  private func getRecordingUpdates(
    _ recordingId: String
  ) throws -> [String: Any] {
    try validateRecordingId(recordingId)
    let root = try recordingsRoot()
    let url = manifestURL(
      recordingsRoot: root,
      recordingId: recordingId
    )
    guard FileManager.default.fileExists(atPath: url.path) else {
      return [
        "status": "missing",
        "segments": [],
        "durationSeconds": NSNull(),
        "totalBytes": 0,
        "error": NSNull()
      ]
    }

    var manifest = try decode(ScreenRecordingManifest.self, from: url)
    try recoverStalledPreparedRecording(
      &manifest,
      at: url,
      recordingsRoot: root
    )
    try recoverStalledRecording(
      &manifest,
      at: url,
      recordingsRoot: root
    )
    try recoverStalledUpload(&manifest, at: url)
    let segments: [[String: Any]] = manifest.segments.map { segment in
      [
        "track": segment.track,
        "type": segment.type,
        "index": segment.index,
        "uri": segment.uri,
        "durationSeconds": segment.durationSeconds,
        "byteLength": segment.byteLength
      ]
    }
    return [
      "status": manifest.status,
      "segments": segments,
      "durationSeconds": bridgeValue(manifest.durationSeconds),
      "totalBytes": manifest.totalBytes,
      "error": bridgeValue(manifest.error)
    ]
  }

  private func cancelRecording(_ recordingId: String) throws {
    try validateRecordingId(recordingId)
    let root = try recordingsRoot()
    let recordingDirectory = root.appendingPathComponent(
      recordingId,
      isDirectory: true
    )
    let url = manifestURL(
      recordingsRoot: root,
      recordingId: recordingId
    )
    if var manifest = try? decode(ScreenRecordingManifest.self, from: url) {
      try recoverStalledRecording(
        &manifest,
        at: url,
        recordingsRoot: root
      )
      if ["recording", "uploading"].contains(manifest.status) {
        throw ScreenRecorderException(
          "Stop the screen recording before discarding it."
        )
      }
    }
    removeActiveConfiguration(
      recordingsRoot: root,
      recordingId: recordingId
    )
    if FileManager.default.fileExists(atPath: recordingDirectory.path) {
      try FileManager.default.removeItem(at: recordingDirectory)
    }
  }

  private func recoverExistingConfiguration(
    recordingsRoot: URL
  ) throws {
    let configurationURL = activeConfigurationURL(recordingsRoot)
    guard let configuration = try? decode(
      ScreenRecordingConfiguration.self,
      from: configurationURL
    ) else {
      return
    }
    let url = manifestURL(
      recordingsRoot: recordingsRoot,
      recordingId: configuration.recordingId
    )
    guard var manifest = try? decode(
      ScreenRecordingManifest.self,
      from: url
    ) else {
      try? FileManager.default.removeItem(at: configurationURL)
      return
    }
    try recoverStalledRecording(
      &manifest,
      at: url,
      recordingsRoot: recordingsRoot
    )
    if manifest.status == "recording" {
      throw ScreenRecorderException(
        "Another screen recording is already active."
      )
    }
    if manifest.status == "prepared" {
      manifest.status = "cancelled"
      manifest.error = nil
      try encode(manifest, to: url)
    }
    removeActiveConfiguration(
      recordingsRoot: recordingsRoot,
      recordingId: configuration.recordingId
    )
  }

  private func recoverStalledPreparedRecording(
    _ manifest: inout ScreenRecordingManifest,
    at url: URL,
    recordingsRoot: URL
  ) throws {
    guard manifest.status == "prepared",
          age(of: url) >= Self.stalePreparedInterval
    else {
      return
    }
    manifest.status = "cancelled"
    manifest.error = nil
    try encode(manifest, to: url)
    removeActiveConfiguration(
      recordingsRoot: recordingsRoot,
      recordingId: manifest.recordingId
    )
  }

  private func recoverStalledRecording(
    _ manifest: inout ScreenRecordingManifest,
    at url: URL,
    recordingsRoot: URL
  ) throws {
    guard manifest.status == "recording",
          age(of: url) >= Self.staleRecordingInterval
    else {
      return
    }
    let videoSegments = manifest.segments.filter {
      $0.track == "video" && $0.type == "media"
    }
    if videoSegments.isEmpty {
      manifest.status = "failed"
      manifest.error = "The screen recording stopped before video was captured."
    } else {
      manifest.status = "finished"
      manifest.durationSeconds = max(
        0.1,
        videoSegments.reduce(0) { $0 + $1.durationSeconds }
      )
      manifest.error = nil
    }
    manifest.uploadStartedAt = nil
    try encode(manifest, to: url)
    removeActiveConfiguration(
      recordingsRoot: recordingsRoot,
      recordingId: manifest.recordingId
    )
  }

  private func recoverStalledUpload(
    _ manifest: inout ScreenRecordingManifest,
    at url: URL
  ) throws {
    guard manifest.status == "uploading",
          let uploadStartedAt = manifest.uploadStartedAt,
          Date().timeIntervalSince(uploadStartedAt) >=
            Self.staleUploadInterval
    else {
      return
    }
    manifest.status = "finished"
    manifest.error = nil
    manifest.uploadStartedAt = nil
    try encode(manifest, to: url)
  }

  private func recordingsRoot() throws -> URL {
    guard let appGroup = Bundle.main.object(
      forInfoDictionaryKey: "CapScreenRecordingAppGroup"
    ) as? String,
      let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroup
      )
    else {
      throw ScreenRecorderException(
        "Cap could not access screen recording storage."
      )
    }
    let root = container.appendingPathComponent(
      "CapScreenRecordings",
      isDirectory: true
    )
    try FileManager.default.createDirectory(
      at: root,
      withIntermediateDirectories: true
    )
    try excludeFromBackup(root)
    return root
  }

  private func activeConfigurationURL(_ recordingsRoot: URL) -> URL {
    recordingsRoot.appendingPathComponent("active-screen-recording.json")
  }

  private func manifestURL(
    recordingsRoot: URL,
    recordingId: String
  ) -> URL {
    recordingsRoot
      .appendingPathComponent(recordingId, isDirectory: true)
      .appendingPathComponent("manifest.json")
  }

  private func removeActiveConfiguration(
    recordingsRoot: URL,
    recordingId: String
  ) {
    let url = activeConfigurationURL(recordingsRoot)
    guard let configuration = try? decode(
      ScreenRecordingConfiguration.self,
      from: url
    ), configuration.recordingId == recordingId else {
      return
    }
    try? FileManager.default.removeItem(at: url)
  }

  private func age(of url: URL) -> TimeInterval {
    let values = try? url.resourceValues(
      forKeys: [.contentModificationDateKey]
    )
    guard let date = values?.contentModificationDate else {
      return 0
    }
    return Date().timeIntervalSince(date)
  }

  private func validateRecordingId(_ recordingId: String) throws {
    guard !recordingId.isEmpty,
          recordingId.range(
            of: "^[A-Za-z0-9_-]+$",
            options: .regularExpression
          ) != nil
    else {
      throw ScreenRecorderException(
        "Cap received an invalid screen recording identifier."
      )
    }
  }

  private func encode<T: Encodable>(_ value: T, to url: URL) throws {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    try encoder.encode(value).write(to: url, options: .atomic)
  }

  private func decode<T: Decodable>(
    _ type: T.Type,
    from url: URL
  ) throws -> T {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(type, from: Data(contentsOf: url))
  }

  private func excludeFromBackup(_ url: URL) throws {
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var mutableURL = url
    try mutableURL.setResourceValues(values)
  }
}
