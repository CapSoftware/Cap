import AVFoundation
import SwiftRs

@_cdecl("start_camera_recording")
func startCameraRecording(/*cameraLabel:String, outputPath: String*/) -> Recording  {
    return Recording()
}

class Recording: NSObject {
    override init() {
        let dispatchQueue = DispatchQueue(label: "sample buffer delegate", attributes: []);

        super.init()

        let cameraLabel = "FaceTime HD Camera";
        let outputPath =  "file:///Users/brendonovich/Desktop/bruh.mp4";

        var types: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera];

        if #available(macOS 14.0, *) {
            types.append(contentsOf: [
                .continuityCamera, .deskViewCamera, .external
            ])
        }

        let videoSession = AVCaptureSession();
        videoSession.sessionPreset = AVCaptureSession.Preset.hd1920x1080;

        let discovery = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .video, position: .unspecified);
        let cameraDevice = discovery.devices.first(where: { device in device.modelID == cameraLabel })!

        let input = try! AVCaptureDeviceInput(device: cameraDevice);
        videoSession.addInput(input)

        let output = AVCaptureVideoDataOutput()
        output.setSampleBufferDelegate(self, queue: dispatchQueue)
        videoSession.addOutput(output);

        //let settings = output.recommendedVideoSettingsForAssetWriter(writingTo: .mov)
        //let assetWriterInput = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        //let adapter = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: assetWriterInput, sourcePixelBufferAttributes: nil)

        videoSession.commitConfiguration();
        videoSession.startRunning()
        
        while(true) {
            
        }
    }
    deinit {
        print("sdjflksjdf")
    }
}

extension Recording: AVCaptureVideoDataOutputSampleBufferDelegate {
    //var assetWriterInput: AVAssetWriterInput;
    //    var startTime: Double?;
    //var adapter: AVAssetWriterInputPixelBufferAdaptor

    //init(/*assetWriterInput: AVAssetWriterInput, adapter: AVAssetWriterInputPixelBufferAdaptor*/) {
    //self.assetWriterInput = assetWriterInput
    //self.adapter = adapter
    //}

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        print(sampleBuffer);

        //        let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds;
        //        if startTime == nil {
        //            startTime = timestamp;
        //        }

        //if assetWriterInput.isReadyForMoreMediaData == true {
        //    let time = CMTime(seconds: timestamp - startTime!, preferredTimescale: CMTimeScale(600));

        //    adapter.append(CMSampleBufferGetImageBuffer(sampleBuffer)!, withPresentationTime: time)
        //}
    }

    func captureOutput(_ output: AVCaptureOutput, didDrop sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        print(sampleBuffer)
    }
}
