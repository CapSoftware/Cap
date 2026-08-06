import ExpoModulesCore

struct CapRecorderOptions: Record {
  @Field var recordingId = ""
  @Field var videoBitrate = 2_500_000
  @Field var segmentDurationSeconds = 2.0
}

public final class CapRecorderModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CapRecorder")

    View(CapRecorderView.self) {
      Events("onCameraReady", "onRecordingSegment", "onRecordingError")

      Prop("active") { (view, active: Bool?) in
        view.active = active ?? true
      }

      Prop("facing") { (view, facing: String?) in
        view.facing = facing ?? "front"
      }

      AsyncFunction("startRecording") { (view, options: CapRecorderOptions) in
        try view.startRecording(options: options)
      }

      AsyncFunction("stopRecording") { (view, promise: Promise) in
        view.stopRecording(promise: promise)
      }
    }
  }
}
