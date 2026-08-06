@preconcurrency import AVFoundation
@preconcurrency import CoreMedia
import CoreImage
import ImageIO
import UniformTypeIdentifiers

struct ScreenRecordingConfiguration: Codable, Sendable {
  let recordingId: String
  let width: Int
  let height: Int
  let videoBitrate: Int
  let segmentDurationSeconds: Double
  let maximumDurationSeconds: Double?
  let createdAt: Date
}

struct ScreenRecordingResult: Sendable {
  let durationSeconds: Double
  let totalBytes: Int
}

struct ScreenRecordingUploadSegment: Codable, Sendable {
  let track: String
  let type: String
  let index: Int
  let uri: String
  let durationSeconds: Double
  let byteLength: Int
}

struct ScreenRecordingManifest: Codable, Sendable {
  let recordingId: String
  var status: String
  var segments: [ScreenRecordingUploadSegment]
  var durationSeconds: Double?
  var totalBytes: Int
  var error: String?
  var uploadStartedAt: Date?
}

enum ScreenRecordingStore {
  static func manifestURL(
    recordingsRoot: URL,
    recordingId: String
  ) -> URL {
    recordingsRoot
      .appendingPathComponent(recordingId, isDirectory: true)
      .appendingPathComponent("manifest.json")
  }

  static func activeConfigurationURL(recordingsRoot: URL) -> URL {
    recordingsRoot.appendingPathComponent("active-screen-recording.json")
  }

  static func encode<T: Encodable>(_ value: T, to url: URL) throws {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    try encoder.encode(value).write(to: url, options: .atomic)
  }

  static func decode<T: Decodable>(_ type: T.Type, from url: URL) throws -> T {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(type, from: Data(contentsOf: url))
  }

  static func removeActiveConfiguration(
    recordingsRoot: URL,
    recordingId: String
  ) {
    let url = activeConfigurationURL(recordingsRoot: recordingsRoot)
    guard let configuration = try? decode(
      ScreenRecordingConfiguration.self,
      from: url
    ), configuration.recordingId == recordingId else {
      return
    }
    try? FileManager.default.removeItem(at: url)
  }
}

private final class ScreenWriterUnavailableError: LocalizedError {
  var errorDescription: String? {
    "Cap could not encode the screen recording."
  }
}

private struct UncheckedTransfer<Value>: @unchecked Sendable {
  let value: Value
}

final class SegmentedScreenWriter:
  NSObject,
  AVAssetWriterDelegate,
  @unchecked Sendable
{
  private let configuration: ScreenRecordingConfiguration
  private let recordingDirectory: URL
  private let recordingsRoot: URL
  private let videoQueue = DispatchQueue(
    label: "so.cap.mobile.screen-recorder.video",
    qos: .userInitiated,
    autoreleaseFrequency: .workItem
  )
  private let audioQueue = DispatchQueue(
    label: "so.cap.mobile.screen-recorder.audio",
    qos: .userInitiated,
    autoreleaseFrequency: .workItem
  )
  private let finishQueue = DispatchQueue(
    label: "so.cap.mobile.screen-recorder.finish",
    qos: .userInitiated,
    autoreleaseFrequency: .workItem
  )
  private let segmentQueue = DispatchQueue(
    label: "so.cap.mobile.screen-recorder.segments",
    qos: .utility,
    autoreleaseFrequency: .workItem
  )
  private let stateLock = NSLock()
  private let videoSlots = DispatchSemaphore(value: 2)
  private let audioSlots = DispatchSemaphore(value: 8)
  private let pendingSamples = DispatchGroup()
  private let pendingSegmentWrites = DispatchGroup()
  private let ciContext = CIContext(options: [.cacheIntermediates: false])
  private let colorSpace = CGColorSpaceCreateDeviceRGB()
  private let onMaximumDurationReached: @Sendable () -> Void
  private let onError: @Sendable (Error) -> Void

  private var manifest: ScreenRecordingManifest
  private var videoWriter: AVAssetWriter?
  private var audioWriter: AVAssetWriter?
  private var videoInput: AVAssetWriterInput?
  private var audioInput: AVAssetWriterInput?
  private var pixelBufferAdaptor: AVAssetWriterInputPixelBufferAdaptor?
  private var recordingStartTime: CMTime?
  private var recordingStartedAt: Date?
  private var latestVideoTime: CMTime?
  private var lastAppendedVideoTime: CMTime?
  private var lastVideoPixelBuffer: CVPixelBuffer?
  private var videoSegmentIndex = 0
  private var audioSegmentIndex = 0
  private var acceptingSamples = true
  private var isFinishing = false
  private var maximumDurationSignalled = false
  private var failureSignalled = false

  init(
    configuration: ScreenRecordingConfiguration,
    recordingsRoot: URL,
    onMaximumDurationReached: @escaping @Sendable () -> Void,
    onError: @escaping @Sendable (Error) -> Void
  ) throws {
    self.configuration = configuration
    self.recordingsRoot = recordingsRoot
    recordingDirectory = recordingsRoot.appendingPathComponent(
      configuration.recordingId,
      isDirectory: true
    )
    self.onMaximumDurationReached = onMaximumDurationReached
    self.onError = onError
    manifest = try ScreenRecordingStore.decode(
      ScreenRecordingManifest.self,
      from: ScreenRecordingStore.manifestURL(
        recordingsRoot: recordingsRoot,
        recordingId: configuration.recordingId
      )
    )
    super.init()
  }

  func markRecordingStarted() throws {
    try segmentQueue.sync {
      manifest.status = "recording"
      manifest.error = nil
      manifest.uploadStartedAt = nil
      try writeManifest()
    }
  }

  func appendVideo(
    _ sampleBuffer: CMSampleBuffer,
    orientation: CGImagePropertyOrientation
  ) {
    guard reserveSampleSlot(videoSlots) else {
      return
    }
    var copiedSampleBuffer: CMSampleBuffer?
    guard CMSampleBufferCreateCopy(
      allocator: kCFAllocatorDefault,
      sampleBuffer: sampleBuffer,
      sampleBufferOut: &copiedSampleBuffer
    ) == noErr,
      let copiedSampleBuffer
    else {
      videoSlots.signal()
      pendingSamples.leave()
      return
    }

    let transferredSampleBuffer = UncheckedTransfer(value: copiedSampleBuffer)
    let pendingSamples = pendingSamples
    let videoSlots = videoSlots
    videoQueue.async { [weak self] in
      defer {
        videoSlots.signal()
        pendingSamples.leave()
      }
      let sampleBuffer = transferredSampleBuffer.value
      guard let self,
            CMSampleBufferDataIsReady(sampleBuffer),
            let sourcePixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer)
      else {
        return
      }

      do {
        let presentationTime = CMSampleBufferGetPresentationTimeStamp(
          sampleBuffer
        )
        if let lastAppendedVideoTime = self.lastAppendedVideoTime {
          let delta = CMTimeSubtract(
            presentationTime,
            lastAppendedVideoTime
          )
          if CMTimeCompare(delta, CMTime(value: 1, timescale: 30)) < 0 {
            return
          }
        }
        if self.videoWriter == nil {
          try self.prepareVideoWriter(startTime: presentationTime)
        }
        guard self.videoWriter?.status == .writing,
              self.videoInput?.isReadyForMoreMediaData == true,
              let adaptor = self.pixelBufferAdaptor,
              let pool = adaptor.pixelBufferPool
        else {
          return
        }

        var targetPixelBuffer: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(
          nil,
          pool,
          &targetPixelBuffer
        ) == kCVReturnSuccess,
          let targetPixelBuffer
        else {
          throw ScreenWriterUnavailableError()
        }
        try self.render(
          sourcePixelBuffer,
          orientation: orientation,
          into: targetPixelBuffer
        )
        guard adaptor.append(
          targetPixelBuffer,
          withPresentationTime: presentationTime
        ) else {
          throw self.videoWriter?.error ?? ScreenWriterUnavailableError()
        }

        self.lastAppendedVideoTime = presentationTime
        self.lastVideoPixelBuffer = targetPixelBuffer
        let duration = CMSampleBufferGetDuration(sampleBuffer)
        self.latestVideoTime = CMTimeAdd(
          presentationTime,
          duration.isValid && duration.isNumeric
            ? duration
            : CMTime(value: 1, timescale: 30)
        )
        self.signalMaximumDurationIfNeeded()
      } catch {
        self.fail(error)
      }
    }
  }

  func appendMicrophoneAudio(_ sampleBuffer: CMSampleBuffer) {
    guard reserveSampleSlot(audioSlots) else {
      return
    }
    var copiedSampleBuffer: CMSampleBuffer?
    guard CMSampleBufferCreateCopy(
      allocator: kCFAllocatorDefault,
      sampleBuffer: sampleBuffer,
      sampleBufferOut: &copiedSampleBuffer
    ) == noErr,
      let copiedSampleBuffer
    else {
      audioSlots.signal()
      pendingSamples.leave()
      return
    }

    let transferredSampleBuffer = UncheckedTransfer(value: copiedSampleBuffer)
    let audioSlots = audioSlots
    let pendingSamples = pendingSamples
    audioQueue.async { [weak self] in
      defer {
        audioSlots.signal()
        pendingSamples.leave()
      }
      let sampleBuffer = transferredSampleBuffer.value
      guard let self,
            CMSampleBufferDataIsReady(sampleBuffer),
            let recordingStartTime = self.currentRecordingStartTime()
      else {
        return
      }

      let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
      guard CMTimeCompare(presentationTime, recordingStartTime) >= 0 else {
        return
      }

      do {
        if self.audioWriter == nil {
          try self.prepareAudioWriter(
            startTime: recordingStartTime,
            sourceFormatHint: CMSampleBufferGetFormatDescription(sampleBuffer)
          )
        }
        guard self.audioWriter?.status == .writing,
              self.audioInput?.isReadyForMoreMediaData == true
        else {
          return
        }
        guard self.audioInput?.append(sampleBuffer) == true else {
          throw self.audioWriter?.error ?? ScreenWriterUnavailableError()
        }
      } catch {
        self.fail(error)
      }
    }
  }

  func finish(
    completion: @escaping @Sendable (
      Result<ScreenRecordingResult, Error>
    ) -> Void
  ) {
    guard stopAcceptingSamples() else {
      return
    }
    pendingSamples.notify(queue: finishQueue) { [weak self] in
      guard let self else {
        completion(.failure(ScreenWriterUnavailableError()))
        return
      }
      guard !self.isFinishing else {
        return
      }
      self.isFinishing = true

      guard let videoWriter = self.videoWriter,
            videoWriter.status == .writing
      else {
        self.completeFailure(
          self.videoWriter?.error ?? ScreenWriterUnavailableError(),
          completion: completion
        )
        return
      }

      self.extendStaticVideoFrame()
      self.videoInput?.markAsFinished()
      self.audioInput?.markAsFinished()
      let finishGroup = DispatchGroup()
      finishGroup.enter()
      videoWriter.finishWriting {
        finishGroup.leave()
      }
      if let audioWriter = self.audioWriter, audioWriter.status == .writing {
        finishGroup.enter()
        audioWriter.finishWriting {
          finishGroup.leave()
        }
      }
      finishGroup.notify(queue: self.finishQueue) {
        self.pendingSegmentWrites.notify(queue: self.segmentQueue) {
          let audioFailed =
            self.audioWriter != nil && self.audioWriter?.status != .completed
          guard videoWriter.status == .completed, !audioFailed else {
            self.completeFailure(
              videoWriter.error ??
                self.audioWriter?.error ??
                ScreenWriterUnavailableError(),
              completion: completion
            )
            return
          }

          let duration = self.recordingDuration()
          self.manifest.status = "finished"
          self.manifest.durationSeconds = duration
          self.manifest.error = nil
          self.manifest.uploadStartedAt = nil
          do {
            try self.writeManifest()
            ScreenRecordingStore.removeActiveConfiguration(
              recordingsRoot: self.recordingsRoot,
              recordingId: self.configuration.recordingId
            )
            completion(
              .success(
                ScreenRecordingResult(
                  durationSeconds: duration,
                  totalBytes: self.manifest.totalBytes
                )
              )
            )
          } catch {
            self.completeFailure(error, completion: completion)
          }
        }
      }
    }
  }

  func assetWriter(
    _ writer: AVAssetWriter,
    didOutputSegmentData segmentData: Data,
    segmentType: AVAssetSegmentType,
    segmentReport: AVAssetSegmentReport?
  ) {
    let track: String
    let mediaType: AVMediaType
    if writer === videoWriter {
      track = "video"
      mediaType = .video
    } else if writer === audioWriter {
      track = "audio"
      mediaType = .audio
    } else {
      return
    }

    let pendingSegmentWrites = pendingSegmentWrites
    pendingSegmentWrites.enter()
    segmentQueue.async { [weak self] in
      defer {
        pendingSegmentWrites.leave()
      }
      guard let self else {
        return
      }

      let isInitialization = segmentType == .initialization
      let index: Int
      let fileName: String
      if isInitialization {
        index = 0
        fileName = "\(track)_init.mp4"
      } else if track == "video" {
        self.videoSegmentIndex += 1
        index = self.videoSegmentIndex
        fileName = String(format: "video_segment_%03d.m4s", index)
      } else {
        self.audioSegmentIndex += 1
        index = self.audioSegmentIndex
        fileName = String(format: "audio_segment_%03d.m4s", index)
      }

      let fileURL = self.recordingDirectory.appendingPathComponent(fileName)
      do {
        try segmentData.write(to: fileURL, options: .atomic)
        let reportedDuration = segmentReport?.trackReports
          .first(where: { $0.mediaType == mediaType })?
          .duration.seconds
        let duration = if isInitialization {
          0.0
        } else if let reportedDuration,
                  reportedDuration.isFinite,
                  reportedDuration > 0
        {
          reportedDuration
        } else {
          self.configuration.segmentDurationSeconds
        }
        let segment = ScreenRecordingUploadSegment(
          track: track,
          type: isInitialization ? "initialization" : "media",
          index: index,
          uri: fileURL.absoluteString,
          durationSeconds: duration,
          byteLength: segmentData.count
        )
        self.manifest.segments.append(segment)
        self.manifest.totalBytes += segmentData.count
        try self.writeManifest()
      } catch {
        self.fail(error)
      }
    }
  }

  private func prepareVideoWriter(startTime: CMTime) throws {
    let writer = AVAssetWriter(contentType: .mpeg4Movie)
    let outputSettings: [String: Any] = [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: configuration.width,
      AVVideoHeightKey: configuration.height,
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: configuration.videoBitrate,
        AVVideoExpectedSourceFrameRateKey: 30,
        AVVideoMaxKeyFrameIntervalKey: 60,
        AVVideoAllowFrameReorderingKey: false,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
      ]
    ]
    let input = AVAssetWriterInput(
      mediaType: .video,
      outputSettings: outputSettings
    )
    input.expectsMediaDataInRealTime = true
    guard writer.canAdd(input) else {
      throw ScreenWriterUnavailableError()
    }
    writer.add(input)
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
      assetWriterInput: input,
      sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String:
          kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: configuration.width,
        kCVPixelBufferHeightKey as String: configuration.height,
        kCVPixelBufferIOSurfacePropertiesKey as String: [:]
      ]
    )
    configureSegmentedWriter(writer, startTime: startTime)
    guard writer.startWriting() else {
      throw writer.error ?? ScreenWriterUnavailableError()
    }
    writer.startSession(atSourceTime: startTime)
    videoWriter = writer
    videoInput = input
    pixelBufferAdaptor = adaptor
    stateLock.lock()
    recordingStartTime = startTime
    recordingStartedAt = Date()
    stateLock.unlock()
  }

  private func prepareAudioWriter(
    startTime: CMTime,
    sourceFormatHint: CMFormatDescription?
  ) throws {
    let writer = AVAssetWriter(contentType: .mpeg4Movie)
    let outputSettings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVSampleRateKey: 48_000,
      AVNumberOfChannelsKey: 1,
      AVEncoderBitRateKey: 96_000
    ]
    let input = AVAssetWriterInput(
      mediaType: .audio,
      outputSettings: outputSettings,
      sourceFormatHint: sourceFormatHint
    )
    input.expectsMediaDataInRealTime = true
    guard writer.canAdd(input) else {
      throw ScreenWriterUnavailableError()
    }
    writer.add(input)
    configureSegmentedWriter(writer, startTime: startTime)
    guard writer.startWriting() else {
      throw writer.error ?? ScreenWriterUnavailableError()
    }
    writer.startSession(atSourceTime: startTime)
    audioWriter = writer
    audioInput = input
  }

  private func configureSegmentedWriter(
    _ writer: AVAssetWriter,
    startTime: CMTime
  ) {
    writer.outputFileTypeProfile = .mpeg4CMAFCompliant
    writer.preferredOutputSegmentInterval = CMTime(
      seconds: configuration.segmentDurationSeconds,
      preferredTimescale: 600
    )
    writer.initialSegmentStartTime = startTime
    writer.shouldOptimizeForNetworkUse = true
    writer.delegate = self
  }

  private func extendStaticVideoFrame() {
    guard videoInput?.isReadyForMoreMediaData == true,
          let adaptor = pixelBufferAdaptor,
          let pixelBuffer = lastVideoPixelBuffer,
          let startTime = recordingStartTime,
          let startedAt = recordingStartedAt
    else {
      return
    }

    let frameDuration = CMTime(value: 1, timescale: 30)
    let elapsed = max(frameDuration.seconds, Date().timeIntervalSince(startedAt))
    let endTime = CMTimeAdd(
      startTime,
      CMTime(seconds: elapsed, preferredTimescale: 600)
    )
    let presentationTime = CMTimeSubtract(endTime, frameDuration)
    guard let latestVideoTime,
          CMTimeCompare(presentationTime, latestVideoTime) > 0
    else {
      return
    }

    guard adaptor.append(
      pixelBuffer,
      withPresentationTime: presentationTime
    ) else {
      return
    }
    self.latestVideoTime = endTime
  }

  private func render(
    _ sourcePixelBuffer: CVPixelBuffer,
    orientation: CGImagePropertyOrientation,
    into targetPixelBuffer: CVPixelBuffer
  ) throws {
    let orientedImage = CIImage(cvPixelBuffer: sourcePixelBuffer)
      .oriented(orientation)
    let extent = orientedImage.extent
    guard extent.width > 0, extent.height > 0 else {
      throw ScreenWriterUnavailableError()
    }
    let targetBounds = CGRect(
      x: 0,
      y: 0,
      width: configuration.width,
      height: configuration.height
    )
    let scale = min(
      targetBounds.width / extent.width,
      targetBounds.height / extent.height
    )
    let normalized = orientedImage.transformed(
      by: CGAffineTransform(
        translationX: -extent.minX,
        y: -extent.minY
      )
    )
    let scaled = normalized.transformed(
      by: CGAffineTransform(scaleX: scale, y: scale)
    )
    let centered = scaled.transformed(
      by: CGAffineTransform(
        translationX: (targetBounds.width - scaled.extent.width) / 2,
        y: (targetBounds.height - scaled.extent.height) / 2
      )
    )
    let background = CIImage(color: .black).cropped(to: targetBounds)
    ciContext.render(
      centered.composited(over: background),
      to: targetPixelBuffer,
      bounds: targetBounds,
      colorSpace: colorSpace
    )
  }

  private func reserveSampleSlot(_ slots: DispatchSemaphore) -> Bool {
    stateLock.lock()
    let canAccept = acceptingSamples
    stateLock.unlock()
    guard canAccept, slots.wait(timeout: .now()) == .success else {
      return false
    }
    stateLock.lock()
    let stillAccepting = acceptingSamples
    if stillAccepting {
      pendingSamples.enter()
    }
    stateLock.unlock()
    if !stillAccepting {
      slots.signal()
    }
    return stillAccepting
  }

  private func stopAcceptingSamples() -> Bool {
    stateLock.lock()
    defer {
      stateLock.unlock()
    }
    guard acceptingSamples else {
      return false
    }
    acceptingSamples = false
    return true
  }

  private func currentRecordingStartTime() -> CMTime? {
    stateLock.lock()
    defer {
      stateLock.unlock()
    }
    return recordingStartTime
  }

  private func signalMaximumDurationIfNeeded() {
    guard !maximumDurationSignalled,
          let maximumDurationSeconds = configuration.maximumDurationSeconds,
          recordingDuration() >= maximumDurationSeconds
    else {
      return
    }
    maximumDurationSignalled = true
    onMaximumDurationReached()
  }

  private func recordingDuration() -> Double {
    if let recordingStartedAt {
      return max(0.1, Date().timeIntervalSince(recordingStartedAt))
    }
    guard let start = recordingStartTime, let end = latestVideoTime else {
      return 0.1
    }
    return max(0.1, CMTimeSubtract(end, start).seconds)
  }

  private func fail(_ error: Error) {
    guard stopAcceptingSamples() else {
      return
    }
    pendingSamples.notify(queue: finishQueue) { [weak self] in
      guard let self, !self.failureSignalled else {
        return
      }
      self.failureSignalled = true
      self.isFinishing = true
      self.videoWriter?.cancelWriting()
      self.audioWriter?.cancelWriting()
      self.segmentQueue.async {
        self.manifest.status = "failed"
        self.manifest.durationSeconds = self.recordingDuration()
        self.manifest.error = error.localizedDescription
        self.manifest.uploadStartedAt = nil
        try? self.writeManifest()
        ScreenRecordingStore.removeActiveConfiguration(
          recordingsRoot: self.recordingsRoot,
          recordingId: self.configuration.recordingId
        )
        self.onError(error)
      }
    }
  }

  private func completeFailure(
    _ error: Error,
    completion: @escaping @Sendable (
      Result<ScreenRecordingResult, Error>
    ) -> Void
  ) {
    manifest.status = "failed"
    manifest.durationSeconds = recordingDuration()
    manifest.error = error.localizedDescription
    manifest.uploadStartedAt = nil
    try? writeManifest()
    ScreenRecordingStore.removeActiveConfiguration(
      recordingsRoot: recordingsRoot,
      recordingId: configuration.recordingId
    )
    completion(.failure(error))
  }

  private func writeManifest() throws {
    try ScreenRecordingStore.encode(
      manifest,
      to: ScreenRecordingStore.manifestURL(
        recordingsRoot: recordingsRoot,
        recordingId: configuration.recordingId
      )
    )
  }
}
