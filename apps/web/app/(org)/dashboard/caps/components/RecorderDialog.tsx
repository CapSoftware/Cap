"use client";

import { Dialog, DialogContent } from "@cap/ui";
import { useState, useEffect } from "react";
import {
  RecordingSourceSelector,
  DeviceSelection,
  RecordingStateDisplay,
  RecordingControls,
  CameraPreview,
} from "./Recorder";
import { useMediaDevices } from "./Recorder/useMediaDevices";
import { useRecording } from "./Recorder/useRecording";

type RecordingSource = "screen" | "window";
type RecordingState =
  | "idle"
  | "countdown"
  | "recording"
  | "uploading"
  | "stopping"
  | "stopped";

type MediaDevice = {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
};

interface RecorderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete?: (videoId: string) => void;
  onStateChange?: (state: RecordingState) => void;
}

export function RecorderDialog({
  open,
  onOpenChange,
  onComplete,
}: RecorderDialogProps) {
  const [selectedSource, setSelectedSource] =
    useState<RecordingSource>("screen");
  const [selectedCamera, setSelectedCamera] = useState<MediaDevice | null>(
    null
  );
  const [selectedMicrophone, setSelectedMicrophone] =
    useState<MediaDevice | null>(null);
  const [isSystemAudioEnabled, setIsSystemAudioEnabled] = useState(false);

  const {
    availableCameras,
    availableMicrophones,
    micPermission,
    cameraPermission,
    checkPermissions,
    requestMicPermission,
    requestCameraPermission,
  } = useMediaDevices();

  const {
    recordingState,
    recordingTime,
    recordedBlob,
    isStartingRecording,
    cameraPreviewStream,
    uploadProgress,
    startRecording,
    stopRecording,
    resetRecording,
  } = useRecording({
    selectedSource,
    selectedCamera,
    selectedMicrophone,
    isSystemAudioEnabled,
  });

  useEffect(() => {
    if (open) {
      checkPermissions();
    } else {
      setSelectedCamera(null);
    }
  }, [open, checkPermissions]);

  useEffect(() => {
    if (recordingState === "stopped" && recordedBlob) {
      onOpenChange(false);
    }
  }, [recordingState, recordedBlob, onOpenChange]);

  const handleRetry = () => {
    resetRecording();
    onOpenChange(true);
  };

  return (
    <>
      <Dialog open={open}>
        <DialogContent
          className="relative p-0 w-full max-w-[300px] rounded-xl border shadow-lg bg-gray-1 border-gray-3"
          onPointerDownOutside={(e: Event) => e.preventDefault()}
          onInteractOutside={(e: Event) => e.preventDefault()}
        >
          <div className="flex relative justify-center flex-col gap-[0.75rem] p-[1rem] min-h-[280px] text-[0.875rem] font-[400] text-[--text-primary]">
            {recordingState === "idle" && (
              <>
                <RecordingSourceSelector
                  selectedSource={selectedSource}
                  onSourceSelect={setSelectedSource}
                  disabled={recordingState !== "idle"}
                />

                <DeviceSelection
                  selectedCamera={selectedCamera}
                  selectedMicrophone={selectedMicrophone}
                  availableCameras={availableCameras}
                  availableMicrophones={availableMicrophones}
                  isSystemAudioEnabled={isSystemAudioEnabled}
                  cameraPermission={cameraPermission}
                  micPermission={micPermission}
                  onCameraSelect={setSelectedCamera}
                  onMicrophoneSelect={setSelectedMicrophone}
                  onSystemAudioToggle={setIsSystemAudioEnabled}
                  onRequestCameraPermission={requestCameraPermission}
                  onRequestMicPermission={requestMicPermission}
                  disabled={recordingState !== "idle"}
                />
              </>
            )}

            {(recordingState === "recording" ||
              recordingState === "uploading") && (
              <div className="flex flex-col items-center justify-center gap-4">
                <RecordingStateDisplay
                  recordingState={recordingState}
                  recordingTime={recordingTime}
                  uploadProgress={uploadProgress}
                />
              </div>
            )}

            <RecordingControls
              recordingState={recordingState}
              isStartingRecording={isStartingRecording}
              onStartRecording={startRecording}
              onStopRecording={stopRecording}
            />
          </div>
        </DialogContent>
      </Dialog>

      {cameraPreviewStream && (
        <CameraPreview
          stream={cameraPreviewStream}
          onClose={() => setSelectedCamera(null)}
        />
      )}
    </>
  );
}
