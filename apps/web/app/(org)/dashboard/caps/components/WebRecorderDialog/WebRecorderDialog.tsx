"use client";

import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@cap/ui";
import { AnimatePresence, motion } from "framer-motion";
import { MonitorIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useDashboardContext } from "../../../Contexts";
import { CameraPreviewWindow } from "./CameraPreviewWindow";
import { CameraSelector } from "./CameraSelector";
import { HowItWorksButton } from "./HowItWorksButton";
import { HowItWorksPanel } from "./HowItWorksPanel";
import { InProgressRecordingBar } from "./InProgressRecordingBar";
import { MicrophoneSelector } from "./MicrophoneSelector";
import { RecordingButton } from "./RecordingButton";
import {
  type RecordingMode,
  RecordingModeSelector,
} from "./RecordingModeSelector";
import { SettingsButton } from "./SettingsButton";
import { SettingsPanel } from "./SettingsPanel";
import { useCameraDevices } from "./useCameraDevices";
import { useDevicePreferences } from "./useDevicePreferences";
import { useDialogInteractions } from "./useDialogInteractions";
import { useMicrophoneDevices } from "./useMicrophoneDevices";
import { useWebRecorder } from "./useWebRecorder";
import { WebRecorderDialogHeader } from "./WebRecorderDialogHeader";
import { dialogVariants } from "./web-recorder-constants";

export const WebRecorderDialog = () => {
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [howItWorksOpen, setHowItWorksOpen] = useState(false);
  const [recordingMode, setRecordingMode] =
    useState<RecordingMode>("fullscreen");
  const [cameraSelectOpen, setCameraSelectOpen] = useState(false);
  const [micSelectOpen, setMicSelectOpen] = useState(false);
  const dialogContentRef = useRef<HTMLDivElement>(null);

  const { activeOrganization } = useDashboardContext();
  const organisationId = activeOrganization?.organization.id;
  const { devices: availableMics, refresh: refreshMics } =
    useMicrophoneDevices(open);
  const { devices: availableCameras, refresh: refreshCameras } =
    useCameraDevices(open);

  const {
    rememberDevices,
    selectedCameraId,
    selectedMicId,
    setSelectedCameraId,
    handleCameraChange,
    handleMicChange,
    handleRememberDevicesChange,
  } = useDevicePreferences({
    open,
    availableCameras,
    availableMics,
  });

  const micEnabled = selectedMicId !== null;

  useEffect(() => {
    if (
      recordingMode === "camera" &&
      !selectedCameraId &&
      availableCameras.length > 0
    ) {
      setSelectedCameraId(availableCameras[0]?.deviceId ?? null);
    }
  }, [recordingMode, selectedCameraId, availableCameras, setSelectedCameraId]);

  const {
    phase,
    durationMs,
    hasAudioTrack,
    isRecording,
    isBusy,
    canStartRecording,
    isBrowserSupported,
    unsupportedReason,
    supportsDisplayRecording,
    supportCheckCompleted,
    screenCaptureWarning,
    startRecording,
    stopRecording,
    resetState,
  } = useWebRecorder({
    organisationId,
    selectedMicId,
    micEnabled,
    recordingMode,
    selectedCameraId,
    onRecordingSurfaceDetected: (mode) => {
      setRecordingMode(mode);
    },
  });

  useEffect(() => {
    if (
      !supportCheckCompleted ||
      supportsDisplayRecording ||
      recordingMode === "camera"
    ) {
      return;
    }

    setRecordingMode("camera");
  }, [
    supportCheckCompleted,
    supportsDisplayRecording,
    recordingMode,
    setRecordingMode,
  ]);

  const {
    handlePointerDownOutside,
    handleFocusOutside,
    handleInteractOutside,
  } = useDialogInteractions({
    dialogContentRef,
    isRecording,
    isBusy,
  });

  const handleOpenChange = (next: boolean) => {
    if (!next && isBusy) {
      toast.info("Keep this dialog open while your upload finishes.");
      return;
    }

    if (!next) {
      resetState();
      setSelectedCameraId(null);
      setRecordingMode("fullscreen");
      setSettingsOpen(false);
      setHowItWorksOpen(false);
    }
    setOpen(next);
  };

  const handleStopClick = () => {
    stopRecording().catch((err: unknown) => {
      console.error("Stop recording error", err);
    });
  };

  const handleClose = () => {
    if (!isBusy) {
      handleOpenChange(false);
    }
  };

  const handleSettingsOpen = () => {
    setSettingsOpen(true);
    setHowItWorksOpen(false);
  };

  const handleHowItWorksOpen = () => {
    setHowItWorksOpen(true);
    setSettingsOpen(false);
  };

  const showInProgressBar = isRecording || isBusy;

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogTrigger asChild>
          <Button variant="blue" size="sm" className="flex items-center gap-2">
            <MonitorIcon className="size-3.5" />
            Record in Browser
          </Button>
        </DialogTrigger>
        <DialogContent
          ref={dialogContentRef}
          className="w-[300px] border-none bg-transparent p-0 [&>button]:hidden"
          onPointerDownOutside={handlePointerDownOutside}
          onFocusOutside={handleFocusOutside}
          onInteractOutside={handleInteractOutside}
        >
          <DialogTitle className="sr-only">Instant Mode Recorder</DialogTitle>
          <AnimatePresence mode="wait">
            {open && (
              <motion.div
                variants={dialogVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                className="relative flex justify-center flex-col p-[1rem] pt-[2rem] gap-[0.75rem] text-[0.875rem] font-[400] text-[--text-primary] bg-gray-2 rounded-lg min-h-[350px]"
              >
                <SettingsButton
                  visible={!settingsOpen}
                  onClick={handleSettingsOpen}
                />
                <SettingsPanel
                  open={settingsOpen}
                  rememberDevices={rememberDevices}
                  onClose={() => setSettingsOpen(false)}
                  onRememberDevicesChange={handleRememberDevicesChange}
                />
                <HowItWorksPanel
                  open={howItWorksOpen}
                  onClose={() => setHowItWorksOpen(false)}
                />
                <WebRecorderDialogHeader
                  isBusy={isBusy}
                  onClose={handleClose}
                />
                <RecordingModeSelector
                  mode={recordingMode}
                  disabled={isBusy}
                  onModeChange={setRecordingMode}
                />
                {screenCaptureWarning && (
                  <div className="rounded-md border border-amber-6 bg-amber-3/60 px-3 py-2 text-xs leading-snug text-amber-12">
                    {screenCaptureWarning}
                  </div>
                )}
                <CameraSelector
                  selectedCameraId={selectedCameraId}
                  availableCameras={availableCameras}
                  dialogOpen={open}
                  disabled={isBusy}
                  open={cameraSelectOpen}
                  onOpenChange={(isOpen) => {
                    setCameraSelectOpen(isOpen);
                    if (isOpen) {
                      setMicSelectOpen(false);
                    }
                  }}
                  onCameraChange={handleCameraChange}
                  onRefreshDevices={refreshCameras}
                />
                <MicrophoneSelector
                  selectedMicId={selectedMicId}
                  availableMics={availableMics}
                  dialogOpen={open}
                  disabled={isBusy}
                  open={micSelectOpen}
                  onOpenChange={(isOpen) => {
                    setMicSelectOpen(isOpen);
                    if (isOpen) {
                      setCameraSelectOpen(false);
                    }
                  }}
                  onMicChange={handleMicChange}
                  onRefreshDevices={refreshMics}
                />
                <RecordingButton
                  isRecording={isRecording}
                  disabled={!canStartRecording || (isBusy && !isRecording)}
                  onStart={startRecording}
                  onStop={handleStopClick}
                />
                {!isBrowserSupported && unsupportedReason && (
                  <div className="rounded-md border border-red-6 bg-red-3/70 px-3 py-2 text-xs leading-snug text-red-12">
                    {unsupportedReason}
                  </div>
                )}
                <HowItWorksButton onClick={handleHowItWorksOpen} />
              </motion.div>
            )}
          </AnimatePresence>
        </DialogContent>
      </Dialog>
      {showInProgressBar && (
        <InProgressRecordingBar
          phase={phase}
          durationMs={durationMs}
          hasAudioTrack={hasAudioTrack}
          onStop={handleStopClick}
        />
      )}
      {selectedCameraId && (
        <CameraPreviewWindow
          cameraId={selectedCameraId}
          onClose={() => handleCameraChange(null)}
        />
      )}
    </>
  );
};
