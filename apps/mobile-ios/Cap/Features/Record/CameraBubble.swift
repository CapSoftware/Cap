@preconcurrency import AVFoundation
import AVKit
import CapKit
import Observation
import os
import SwiftUI
import UIKit
import VideoToolbox

/// The camera floating over other apps while the screen is recorded, so it's captured with it.
///
/// It's a video call style Picture in Picture window fed straight from the camera: iOS keeps those
/// small, like a FaceTime call, and shows no playback controls. It outlives the record screen,
/// since recording carries on after Cap is closed, and stops when the screen recording does.
@MainActor
@Observable
final class CameraBubble: NSObject {
    enum State: Equatable {
        case idle
        case ready
        case denied
        case unavailable
    }

    static let shared = CameraBubble()
    nonisolated private static let log = Logger(subsystem: "so.cap.mobile", category: "bubble")

    private(set) var state: State = .idle
    private(set) var isFloating = false

    /// On the record screen; the floating window grows out of it.
    @ObservationIgnored let preview = LayerView()
    /// Inside the floating window.
    @ObservationIgnored private let floating = LayerView()
    @ObservationIgnored private let capture = CameraCapture(configuration: .bubble)
    @ObservationIgnored private var pip: AVPictureInPictureController?
    @ObservationIgnored private var observer: NSObjectProtocol?

    private override init() {
        super.init()
        floating.onLayout = { size in
            // iOS picks the window's size; kept so a test can see what it chose.
            let screen = UIScreen.main.bounds.size
            ProcessStats.note("Camera bubble window \(Int(size.width))x\(Int(size.height)) pt on a \(Int(screen.width))x\(Int(screen.height)) pt screen")
        }
        nonisolated(unsafe) let layers = [preview.display, floating.display]
        let square = SquareCrop(side: 360)
        capture.onFrame = { buffer in
            let frame = square.crop(buffer) ?? buffer
            for layer in layers { CameraBubble.show(frame, on: layer) }
        }
        // Stopping the screen recording, from anywhere, puts the camera away.
        observer = NotificationCenter.default.addObserver(forName: UIScreen.capturedDidChangeNotification, object: nil, queue: .main) { note in
            nonisolated(unsafe) let screen = note.object as? UIScreen
            MainActor.assumeIsolated {
                if screen?.isCaptured == false, CameraBubble.shared.isFloating { CameraBubble.shared.stop() }
            }
        }
    }

    func prepare() async {
        guard state != .ready else { return }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            break
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .video) else {
                state = .denied
                return
            }
        default:
            state = .denied
            return
        }
        let result = await withCheckedContinuation { continuation in
            capture.start(position: .front, microphone: false) { continuation.resume(returning: $0) }
        }
        guard case .success = result else {
            state = .unavailable
            return
        }
        // Mixing leaves other sound alone.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback, options: [.mixWithOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        if pip == nil, AVPictureInPictureController.isPictureInPictureSupported() {
            let call = AVPictureInPictureVideoCallViewController()
            // Only the shape counts; iOS sizes the window.
            call.preferredContentSize = CGSize(width: 1000, height: 1000)
            floating.frame = call.view.bounds
            floating.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            call.view.addSubview(floating)
            let controller = AVPictureInPictureController(contentSource: .init(activeVideoCallSourceView: preview, contentViewController: call))
            controller.canStartPictureInPictureAutomaticallyFromInline = true
            controller.delegate = self
            pip = controller
        }
        ProcessStats.note("Camera bubble ready, floats \(pip != nil)")
        state = .ready
    }

    /// Floats the camera over everything; called once the screen recording has started.
    func float() {
        Task {
            // The system sheet can still be closing, which briefly blocks Picture in Picture.
            for _ in 0..<10 {
                guard state == .ready, let pip, !pip.isPictureInPictureActive else { return }
                if pip.isPictureInPicturePossible {
                    pip.startPictureInPicture()
                    return
                }
                try? await Task.sleep(for: .milliseconds(300))
            }
        }
    }

    func stop() {
        pip?.stopPictureInPicture()
        pip = nil
        floating.removeFromSuperview()
        capture.stop()
        preview.display.sampleBufferRenderer.flush()
        floating.display.sampleBufferRenderer.flush()
        state = .idle
        isFloating = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Leaving the record screen keeps the camera only while it's part of a recording.
    func releaseUnlessFloating() {
        if !isFloating { stop() }
    }

    nonisolated private static func show(_ buffer: CMSampleBuffer, on layer: AVSampleBufferDisplayLayer) {
        // Live frames: show each as it arrives rather than on a playback clock.
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: true), CFArrayGetCount(attachments) > 0 {
            let dictionary = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(dictionary, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(), Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
        }
        let renderer = layer.sampleBufferRenderer
        if renderer.status == .failed { renderer.flush() }
        if renderer.isReadyForMoreMediaData { renderer.enqueue(buffer) }
    }

    /// A live camera image filling its view.
    final class LayerView: UIView {
        let display = AVSampleBufferDisplayLayer()
        var onLayout: ((CGSize) -> Void)?
        private var reported = CGSize.zero

        init() {
            super.init(frame: .zero)
            isUserInteractionEnabled = false
            display.videoGravity = .resizeAspectFill
            layer.addSublayer(display)
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        override func layoutSubviews() {
            super.layoutSubviews()
            CATransaction.performWithoutAnimation { display.frame = bounds }
            if bounds.size != reported, bounds.width > 0 {
                reported = bounds.size
                onLayout?(bounds.size)
            }
        }
    }
}

extension CameraBubble: AVPictureInPictureControllerDelegate {
    nonisolated func pictureInPictureControllerDidStartPictureInPicture(_ controller: AVPictureInPictureController) {
        ProcessStats.note("Camera bubble floating")
        MainActor.assumeIsolated {
            isFloating = true
        }
    }

    nonisolated func pictureInPictureControllerDidStopPictureInPicture(_ controller: AVPictureInPictureController) {
        MainActor.assumeIsolated { isFloating = false }
    }

    nonisolated func pictureInPictureController(_ controller: AVPictureInPictureController, failedToStartPictureInPictureWithError error: any Error) {
        Self.log.error("Camera bubble failed to float: \(error.localizedDescription, privacy: .public)")
        ProcessStats.note("Camera bubble failed to float: \(error.localizedDescription)")
    }
}

/// The camera bubble's live image on the record screen, which Picture in Picture lifts out of.
struct CameraBubbleView: UIViewRepresentable {
    let bubble: CameraBubble

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.isUserInteractionEnabled = false
        bubble.preview.frame = container.bounds
        bubble.preview.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(bubble.preview)
        return container
    }

    func updateUIView(_ view: UIView, context: Context) {}
}

private extension CATransaction {
    static func performWithoutAnimation(_ changes: () -> Void) {
        begin()
        setDisableActions(true)
        changes()
        commit()
    }
}

/// Crops camera frames to a centred square in hardware. Used only from the camera's output queue.
private nonisolated final class SquareCrop: @unchecked Sendable {
    private let side: Int
    private var session: VTPixelTransferSession?
    private var pool: CVPixelBufferPool?
    private var format: CMVideoFormatDescription?

    init(side: Int) {
        self.side = side
        VTPixelTransferSessionCreate(allocator: kCFAllocatorDefault, pixelTransferSessionOut: &session)
        if let session {
            // Trim: cut the source to the destination's shape, then scale, so nothing is squashed.
            VTSessionSetProperty(session, key: kVTPixelTransferPropertyKey_ScalingMode, value: kVTScalingMode_Trim)
        }
        CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferWidthKey: side,
            kCVPixelBufferHeightKey: side,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as [String: Any],
        ] as CFDictionary, &pool)
    }

    func crop(_ buffer: CMSampleBuffer) -> CMSampleBuffer? {
        guard let session, let pool, let source = CMSampleBufferGetImageBuffer(buffer) else { return nil }
        var output: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &output) == kCVReturnSuccess, let output,
              VTPixelTransferSessionTransferImage(session, from: source, to: output) == noErr
        else { return nil }
        if format == nil || !CMVideoFormatDescriptionMatchesImageBuffer(format!, imageBuffer: output) {
            format = nil
            CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: output, formatDescriptionOut: &format)
        }
        guard let format else { return nil }
        var timing = CMSampleTimingInfo()
        CMSampleBufferGetSampleTimingInfo(buffer, at: 0, timingInfoOut: &timing)
        var cropped: CMSampleBuffer?
        CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: output, formatDescription: format, sampleTiming: &timing, sampleBufferOut: &cropped)
        return cropped
    }
}
