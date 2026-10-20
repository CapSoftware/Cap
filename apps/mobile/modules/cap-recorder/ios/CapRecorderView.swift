@preconcurrency import AVFoundation
import ExpoModulesCore
import UniformTypeIdentifiers
import UIKit

private final class RecorderUnavailableException: Exception {
  override var reason: String {
    "The camera recorder is not ready."
  }
}

private final class RecorderBusyException: Exception {
  override var reason: String {
    "A camera recording is already active."
  }
}

public final class CapRecorderView: ExpoView, AVCaptureVideoDataOutputSampleBufferDelegate,
  AVCaptureAudioDataOutputSampleBufferDelegate, AVAssetWriterDelegate
{
  private let session = AVCaptureSession()
  private let sessionQueue = DispatchQueue(label: "so.cap.mobile.recorder.session", qos: .userInitiated)
  private let outputQueue = DispatchQueue(label: "so.cap.mobile.recorder.output", qos: .userInteractive)
  private let segmentQueue = DispatchQueue(label: "so.cap.mobile.recorder.segments", qos: .utility)
  private let previewLayer: AVCaptureVideoPreviewLayer
  private let videoOutput = AVCaptureVideoDataOutput()
  private let audioOutput = AVCaptureAudioDataOutput()

  private var cameraInput: AVCaptureDeviceInput?
  private var videoWriter: AVAssetWriter?
  private var audioWriter: AVAssetWriter?
  private var videoWriterInput: AVAssetWriterInput?
  private var audioWriterInput: AVAssetWriterInput?
  private var recordingDirectory: URL?
  private var recordingStartTime: CMTime?
  private var latestVideoTime: CMTime?
  private var segmentDurationSeconds = 2.0
  private var videoBitrate = 2_500_000
  private var videoSegmentIndex = 0
  private var audioSegmentIndex = 0
  private var segmentCount = 0
  private var totalBytes = 0
  private var isRecording = false
  private var isStopping = false
  private var stopPromise: Promise?
  private var configured = false

  var active = true {
    didSet {
      updateSessionRunningState()
    }
  }

  var facing = "front" {
    didSet {
      guard facing != oldValue else {
        return
      }
      reconfigureCamera()
    }
  }

  let onCameraReady = EventDispatcher()
  let onRecordingSegment = EventDispatcher()
  let onRecordingError = EventDispatcher()

  public required init(appContext: AppContext? = nil) {
    previewLayer = AVCaptureVideoPreviewLayer(session: session)
    super.init(appContext: appContext)
    backgroundColor = .black
    previewLayer.videoGravity = .resizeAspectFill
    layer.insertSublayer(previewLayer, at: 0)
    configureSession()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    previewLayer.frame = bounds
    updatePreviewConnection()
  }

  public override func removeFromSuperview() {
    super.removeFromSuperview()
    sessionQueue.async { [weak self] in
      guard let self, self.session.isRunning else {
        return
      }
      self.session.stopRunning()
    }
  }

  func startRecording(options: CapRecorderOptions) throws {
    guard configured else {
      throw RecorderUnavailableException()
    }

    var startError: Error?
    outputQueue.sync {
      if self.isRecording || self.isStopping {
        startError = RecorderBusyException()
        return
      }

      do {
        let directory = try self.makeRecordingDirectory(id: options.recordingId)
        self.recordingDirectory = directory
        self.segmentDurationSeconds = min(6, max(1, options.segmentDurationSeconds))
        self.videoBitrate = min(8_000_000, max(800_000, options.videoBitrate))
        self.videoWriter = nil
        self.audioWriter = nil
        self.videoWriterInput = nil
        self.audioWriterInput = nil
        self.recordingStartTime = nil
        self.latestVideoTime = nil
        self.videoSegmentIndex = 0
        self.audioSegmentIndex = 0
        self.segmentCount = 0
        self.totalBytes = 0
        self.stopPromise = nil
        self.isStopping = false
        self.isRecording = true
      } catch {
        startError = error
      }
    }

    if let startError {
      throw startError
    }
  }

  func stopRecording(promise: Promise) {
    outputQueue.async { [weak self] in
      guard let self else {
        promise.reject(RecorderUnavailableException())
        return
      }
      guard self.isRecording, !self.isStopping else {
        promise.reject(RecorderUnavailableException())
        return
      }

      self.isStopping = true
      self.isRecording = false
      self.stopPromise = promise
      self.finishWriter()
    }
  }

  public func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from _: AVCaptureConnection
  ) {
    guard CMSampleBufferDataIsReady(sampleBuffer), isRecording else {
      return
    }

    if output === videoOutput {
      appendVideo(sampleBuffer)
    } else if output === audioOutput {
      appendAudio(sampleBuffer)
    }
  }

  public func assetWriter(
    _ writer: AVAssetWriter,
    didOutputSegmentData segmentData: Data,
    segmentType: AVAssetSegmentType,
    segmentReport: AVAssetSegmentReport?
  ) {
    guard let recordingDirectory else {
      return
    }

    segmentQueue.async { [weak self] in
      guard let self else {
        return
      }

      let track: String
      if writer === self.videoWriter {
        track = "video"
      } else if writer === self.audioWriter {
        track = "audio"
      } else {
        return
      }

      let isInitialization = segmentType == .initialization
      let index: Int
      let fileName: String
      if isInitialization {
        index = 0
        fileName = "\(track)_init.mp4"
      } else {
        if track == "video" {
          self.videoSegmentIndex += 1
          index = self.videoSegmentIndex
        } else {
          self.audioSegmentIndex += 1
          index = self.audioSegmentIndex
        }
        fileName = String(format: "%@_segment_%03d.m4s", track, index)
      }

      let fileURL = recordingDirectory.appendingPathComponent(fileName)
      do {
        try segmentData.write(to: fileURL, options: .atomic)
      } catch {
        self.outputQueue.async {
          self.failActiveRecording(error)
        }
        return
      }

      let reportedDuration = segmentReport?.trackReports
        .first(where: { $0.mediaType == (track == "video" ? .video : .audio) })?
        .duration.seconds
      let duration = if let reportedDuration,
                        reportedDuration.isFinite,
                        reportedDuration > 0
      {
        reportedDuration
      } else {
        self.segmentDurationSeconds
      }

      if !isInitialization {
        self.segmentCount += 1
      }
      self.totalBytes += segmentData.count

      DispatchQueue.main.async {
        self.onRecordingSegment([
          "track": track,
          "type": isInitialization ? "initialization" : "media",
          "index": index,
          "uri": fileURL.absoluteString,
          "durationSeconds": isInitialization ? 0 : duration,
          "byteLength": segmentData.count
        ])
      }
    }
  }

  private func configureSession() {
    sessionQueue.async { [weak self] in
      guard let self else {
        return
      }

      do {
        try self.configureAudioSession()
        self.session.beginConfiguration()
        do {
          if self.session.canSetSessionPreset(.hd1280x720) {
            self.session.sessionPreset = .hd1280x720
          }
          try self.addCameraInput()
          try self.addMicrophoneInput()
          self.addCaptureOutputs()
        } catch {
          self.session.commitConfiguration()
          throw error
        }
        self.session.commitConfiguration()
        self.configured = true
        if self.active && !self.session.isRunning {
          self.session.startRunning()
        }
        DispatchQueue.main.async {
          self.updatePreviewConnection()
          self.onCameraReady()
        }
      } catch {
        self.emitRecordingError(error.localizedDescription)
      }
    }
  }

  private func configureAudioSession() throws {
    let audioSession = AVAudioSession.sharedInstance()
    try audioSession.setCategory(
      .playAndRecord,
      mode: .videoRecording,
      options: [.defaultToSpeaker, .allowBluetoothHFP]
    )
    try audioSession.setActive(true)
  }

  private func addCameraInput() throws {
    let position: AVCaptureDevice.Position = facing == "back" ? .back : .front
    guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position) else {
      throw RecorderUnavailableException()
    }

    try camera.lockForConfiguration()
    if camera.isFocusModeSupported(.continuousAutoFocus) {
      camera.focusMode = .continuousAutoFocus
    }
    if camera.isExposureModeSupported(.continuousAutoExposure) {
      camera.exposureMode = .continuousAutoExposure
    }
    let frameDuration = CMTime(value: 1, timescale: 30)
    let supportsThirtyFps = camera.activeFormat.videoSupportedFrameRateRanges.contains {
      $0.minFrameRate <= 30 && $0.maxFrameRate >= 30
    }
    if supportsThirtyFps {
      camera.activeVideoMinFrameDuration = frameDuration
      camera.activeVideoMaxFrameDuration = frameDuration
    }
    camera.unlockForConfiguration()

    let input = try AVCaptureDeviceInput(device: camera)
    guard session.canAddInput(input) else {
      throw RecorderUnavailableException()
    }
    session.addInput(input)
    cameraInput = input
  }

  private func addMicrophoneInput() throws {
    guard let microphone = AVCaptureDevice.default(for: .audio) else {
      throw RecorderUnavailableException()
    }
    let input = try AVCaptureDeviceInput(device: microphone)
    guard session.canAddInput(input) else {
      throw RecorderUnavailableException()
    }
    session.addInput(input)
  }

  private func addCaptureOutputs() {
    videoOutput.alwaysDiscardsLateVideoFrames = true
    videoOutput.videoSettings = [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
    ]
    videoOutput.setSampleBufferDelegate(self, queue: outputQueue)
    audioOutput.setSampleBufferDelegate(self, queue: outputQueue)

    if session.canAddOutput(videoOutput) {
      session.addOutput(videoOutput)
    }
    if session.canAddOutput(audioOutput) {
      session.addOutput(audioOutput)
    }
    updateVideoOutputConnection()
  }

  private func updateSessionRunningState() {
    sessionQueue.async { [weak self] in
      guard let self, self.configured else {
        return
      }
      if self.active && !self.session.isRunning {
        self.session.startRunning()
        DispatchQueue.main.async {
          self.onCameraReady()
        }
      } else if !self.active && self.session.isRunning {
        self.session.stopRunning()
      }
    }
  }

  private func reconfigureCamera() {
    sessionQueue.async { [weak self] in
      guard let self, self.configured, !self.isRecording, !self.isStopping else {
        return
      }
      self.session.beginConfiguration()
      defer { self.session.commitConfiguration() }
      if let cameraInput = self.cameraInput {
        self.session.removeInput(cameraInput)
      }
      do {
        try self.addCameraInput()
        self.updateVideoOutputConnection()
        DispatchQueue.main.async {
          self.updatePreviewConnection()
          self.onCameraReady()
        }
      } catch {
        self.emitRecordingError(error.localizedDescription)
      }
    }
  }

  private func updateVideoOutputConnection() {
    guard let connection = videoOutput.connection(with: .video) else {
      return
    }
    if connection.isVideoOrientationSupported {
      connection.videoOrientation = .portrait
    }
    if connection.isVideoMirroringSupported {
      connection.automaticallyAdjustsVideoMirroring = false
      connection.isVideoMirrored = facing == "front"
    }
    if connection.isVideoStabilizationSupported {
      connection.preferredVideoStabilizationMode = .standard
    }
  }

  private func updatePreviewConnection() {
    guard let connection = previewLayer.connection else {
      return
    }
    if connection.isVideoOrientationSupported {
      connection.videoOrientation = .portrait
    }
    if connection.isVideoMirroringSupported {
      connection.automaticallyAdjustsVideoMirroring = false
      connection.isVideoMirrored = facing == "front"
    }
  }

  private func appendVideo(_ sampleBuffer: CMSampleBuffer) {
    if videoWriter == nil || audioWriter == nil {
      do {
        try prepareWriter(startTime: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
      } catch {
        failActiveRecording(error)
        return
      }
    }

    guard videoWriter?.status == .writing,
          videoWriterInput?.isReadyForMoreMediaData == true
    else {
      return
    }
    if videoWriterInput?.append(sampleBuffer) == true {
      latestVideoTime = CMTimeAdd(
        CMSampleBufferGetPresentationTimeStamp(sampleBuffer),
        CMSampleBufferGetDuration(sampleBuffer)
      )
    } else {
      failActiveRecording(videoWriter?.error ?? RecorderUnavailableException())
    }
  }

  private func appendAudio(_ sampleBuffer: CMSampleBuffer) {
    guard audioWriter?.status == .writing,
          audioWriterInput?.isReadyForMoreMediaData == true
    else {
      return
    }
    if audioWriterInput?.append(sampleBuffer) == false {
      failActiveRecording(audioWriter?.error ?? RecorderUnavailableException())
    }
  }

  private func prepareWriter(startTime: CMTime) throws {
    let videoWriter = try AVAssetWriter(contentType: .mpeg4Movie)
    let audioWriter = try AVAssetWriter(contentType: .mpeg4Movie)
    let videoSettings: [String: Any] = [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: 720,
      AVVideoHeightKey: 1280,
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: videoBitrate,
        AVVideoExpectedSourceFrameRateKey: 30,
        AVVideoMaxKeyFrameIntervalKey: 60,
        AVVideoAllowFrameReorderingKey: false,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
      ]
    ]
    let audioSettings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVSampleRateKey: 48_000,
      AVNumberOfChannelsKey: 1,
      AVEncoderBitRateKey: 96_000
    ]
    let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
    let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
    videoInput.expectsMediaDataInRealTime = true
    audioInput.expectsMediaDataInRealTime = true

    guard videoWriter.canAdd(videoInput), audioWriter.canAdd(audioInput) else {
      throw RecorderUnavailableException()
    }
    videoWriter.add(videoInput)
    audioWriter.add(audioInput)

    self.videoWriter = videoWriter
    self.audioWriter = audioWriter
    let segmentInterval = CMTime(
      seconds: segmentDurationSeconds,
      preferredTimescale: 600
    )
    do {
      for writer in [videoWriter, audioWriter] {
        writer.outputFileTypeProfile = .mpeg4CMAFCompliant
        writer.preferredOutputSegmentInterval = segmentInterval
        writer.initialSegmentStartTime = startTime
        writer.delegate = self
        guard writer.startWriting() else {
          throw writer.error ?? RecorderUnavailableException()
        }
        writer.startSession(atSourceTime: startTime)
      }
    } catch {
      videoWriter.cancelWriting()
      audioWriter.cancelWriting()
      self.videoWriter = nil
      self.audioWriter = nil
      throw error
    }

    videoWriterInput = videoInput
    audioWriterInput = audioInput
    recordingStartTime = startTime
  }

  private func finishWriter() {
    guard let videoWriter,
          let audioWriter,
          videoWriter.status == .writing,
          audioWriter.status == .writing
    else {
      finishWithError(videoWriter?.error ?? audioWriter?.error ?? RecorderUnavailableException())
      return
    }

    videoWriterInput?.markAsFinished()
    audioWriterInput?.markAsFinished()
    let finishGroup = DispatchGroup()
    finishGroup.enter()
    videoWriter.finishWriting {
      finishGroup.leave()
    }
    finishGroup.enter()
    audioWriter.finishWriting {
      finishGroup.leave()
    }
    finishGroup.notify(queue: segmentQueue) { [weak self] in
      guard let self else {
        return
      }
      self.outputQueue.async {
        self.resolveStop(videoWriter: videoWriter, audioWriter: audioWriter)
      }
    }
  }

  private func resolveStop(videoWriter: AVAssetWriter, audioWriter: AVAssetWriter) {
    guard videoWriter.status == .completed, audioWriter.status == .completed else {
      finishWithError(
        videoWriter.error ?? audioWriter.error ?? RecorderUnavailableException()
      )
      return
    }

    let duration: Double
    if let start = recordingStartTime, let end = latestVideoTime {
      duration = max(0.1, CMTimeSubtract(end, start).seconds)
    } else {
      duration = 0.1
    }
    let result: [String: Any] = [
      "durationSeconds": duration,
      "segmentCount": segmentCount,
      "totalBytes": totalBytes
    ]

    let promise = stopPromise
    resetWriterState()
    DispatchQueue.main.async {
      promise?.resolve(result)
    }
  }

  private func finishWithError(_ error: Error) {
    let promise = stopPromise
    videoWriter?.cancelWriting()
    audioWriter?.cancelWriting()
    resetWriterState()
    DispatchQueue.main.async {
      promise?.reject(error)
      self.emitRecordingError(error.localizedDescription)
    }
  }

  private func failActiveRecording(_ error: Error) {
    guard isRecording || isStopping else {
      return
    }
    finishWithError(error)
  }

  private func resetWriterState() {
    videoWriter = nil
    audioWriter = nil
    videoWriterInput = nil
    audioWriterInput = nil
    recordingDirectory = nil
    recordingStartTime = nil
    latestVideoTime = nil
    stopPromise = nil
    isRecording = false
    isStopping = false
  }

  private func makeRecordingDirectory(id: String) throws -> URL {
    guard !id.isEmpty, id.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else {
      throw RecorderUnavailableException()
    }
    let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("CapRecordings", isDirectory: true)
    let directory = root.appendingPathComponent(id, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var resourceValues = URLResourceValues()
    resourceValues.isExcludedFromBackup = true
    var mutableDirectory = directory
    try? mutableDirectory.setResourceValues(resourceValues)
    return directory
  }

  private func emitRecordingError(_ message: String) {
    DispatchQueue.main.async {
      self.onRecordingError(["message": message])
    }
  }
}
