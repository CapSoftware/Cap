import CoreMedia
import Foundation
import ImageIO
import ReplayKit

final class SampleHandler: RPBroadcastSampleHandler {
  private static let finishWaitInterval: TimeInterval = 4

  private let stateLock = NSLock()
  private var writer: SegmentedScreenWriter?
  private var isFinishing = false

  override func broadcastStarted(withSetupInfo _: [String: NSObject]?) {
    do {
      let (configuration, recordingsRoot) = try loadRecordingContext()
      let writer = try SegmentedScreenWriter(
        configuration: configuration,
        recordingsRoot: recordingsRoot
      ) { [weak self] in
        self?.finishAtDurationLimit()
      } onError: { [weak self] error in
        self?.finishWithWriterError(error)
      }
      self.writer = writer
      try writer.markRecordingStarted()
    } catch {
      markPreparedRecordingFailed(error)
      finishBroadcastWithError(error)
    }
  }

  override func broadcastFinished() {
    guard let writer, beginFinishing() else {
      return
    }
    let completion = DispatchSemaphore(value: 0)
    writer.finish { _ in
      completion.signal()
    }
    _ = completion.wait(timeout: .now() + Self.finishWaitInterval)
  }

  override func processSampleBuffer(
    _ sampleBuffer: CMSampleBuffer,
    with sampleBufferType: RPSampleBufferType
  ) {
    guard !finishing else {
      return
    }
    switch sampleBufferType {
    case .video:
      writer?.appendVideo(
        sampleBuffer,
        orientation: videoOrientation(sampleBuffer)
      )
    case .audioMic:
      writer?.appendMicrophoneAudio(sampleBuffer)
    case .audioApp:
      break
    @unknown default:
      break
    }
  }

  private func finishAtDurationLimit() {
    guard let writer, beginFinishing() else {
      return
    }
    writer.finish { [weak self] result in
      guard let self else {
        return
      }
      switch result {
      case .success:
        self.finishBroadcastWithError(
          NSError(
            domain: "so.cap.mobile.screen-recorder",
            code: 2,
            userInfo: [
              NSLocalizedDescriptionKey:
                "Your screen recording reached the Free plan limit and was saved."
            ]
          )
        )
      case let .failure(error):
        self.finishBroadcastWithError(error)
      }
    }
  }

  private func finishWithWriterError(_ error: Error) {
    guard beginFinishing() else {
      return
    }
    finishBroadcastWithError(error)
  }

  private var finishing: Bool {
    stateLock.lock()
    defer {
      stateLock.unlock()
    }
    return isFinishing
  }

  private func beginFinishing() -> Bool {
    stateLock.lock()
    defer {
      stateLock.unlock()
    }
    guard !isFinishing else {
      return false
    }
    isFinishing = true
    return true
  }

  private func loadRecordingContext() throws
    -> (ScreenRecordingConfiguration, URL)
  {
    guard let appGroup = Bundle.main.object(
      forInfoDictionaryKey: "CapScreenRecordingAppGroup"
    ) as? String,
      let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroup
      )
    else {
      throw NSError(
        domain: "so.cap.mobile.screen-recorder",
        code: 1,
        userInfo: [
          NSLocalizedDescriptionKey: "Cap could not access the screen recording."
        ]
      )
    }
    let recordingsRoot = container.appendingPathComponent(
      "CapScreenRecordings",
      isDirectory: true
    )
    let configuration = try ScreenRecordingStore.decode(
      ScreenRecordingConfiguration.self,
      from: ScreenRecordingStore.activeConfigurationURL(
        recordingsRoot: recordingsRoot
      )
    )
    return (configuration, recordingsRoot)
  }

  private func markPreparedRecordingFailed(_ error: Error) {
    guard let (configuration, recordingsRoot) = try? loadRecordingContext()
    else {
      return
    }
    let manifestURL = ScreenRecordingStore.manifestURL(
      recordingsRoot: recordingsRoot,
      recordingId: configuration.recordingId
    )
    guard var manifest = try? ScreenRecordingStore.decode(
      ScreenRecordingManifest.self,
      from: manifestURL
    ) else {
      return
    }
    manifest.status = "failed"
    manifest.error = error.localizedDescription
    manifest.uploadStartedAt = nil
    try? ScreenRecordingStore.encode(manifest, to: manifestURL)
    ScreenRecordingStore.removeActiveConfiguration(
      recordingsRoot: recordingsRoot,
      recordingId: configuration.recordingId
    )
  }

  private func videoOrientation(
    _ sampleBuffer: CMSampleBuffer
  ) -> CGImagePropertyOrientation {
    guard let rawValue = CMGetAttachment(
      sampleBuffer,
      key: RPVideoSampleOrientationKey as CFString,
      attachmentModeOut: nil
    ) as? NSNumber else {
      return .up
    }
    return CGImagePropertyOrientation(rawValue: rawValue.uint32Value) ?? .up
  }
}
