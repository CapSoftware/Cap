"use client";

import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  Switch,
} from "@cap/ui";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeftIcon, CircleHelpIcon, MonitorIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import CogIcon from "@/app/(org)/dashboard/_components/AnimatedIcons/Cog";
import { useDashboardContext } from "../../../Contexts";
import { CameraSelector } from "./CameraSelector";
import { CameraPreviewWindow } from "./CameraPreviewWindow";
import { MicrophoneSelector } from "./MicrophoneSelector";
import { RecordingButton } from "./RecordingButton";
import {
  RecordingModeSelector,
  type RecordingMode,
} from "./RecordingModeSelector";
import { WebRecorderDialogHeader } from "./WebRecorderDialogHeader";
import { dialogVariants } from "./web-recorder-constants";
import { useCameraDevices } from "./useCameraDevices";
import { useMicrophoneDevices } from "./useMicrophoneDevices";
import { useWebRecorder } from "./useWebRecorder";

const REMEMBER_DEVICES_KEY = "cap-web-recorder-remember-devices";
const PREFERRED_CAMERA_KEY = "cap-web-recorder-preferred-camera";
const PREFERRED_MICROPHONE_KEY = "cap-web-recorder-preferred-microphone";

export const WebRecorderDialog = () => {
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [howItWorksOpen, setHowItWorksOpen] = useState(false);
  const [selectedMicId, setSelectedMicId] = useState<string | null>(null);
  const [recordingMode, setRecordingMode] =
    useState<RecordingMode>("fullscreen");
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const [cameraSelectOpen, setCameraSelectOpen] = useState(false);
  const [micSelectOpen, setMicSelectOpen] = useState(false);
  const [rememberDevices, setRememberDevices] = useState(false);
  const dialogContentRef = useRef<HTMLDivElement>(null);

  const { activeOrganization } = useDashboardContext();
  const organisationId = activeOrganization?.organization.id;
  const { devices: availableMics, refresh: refreshMics } =
    useMicrophoneDevices(open);
  const { devices: availableCameras, refresh: refreshCameras } =
    useCameraDevices(open);

  const micEnabled = selectedMicId !== null;

  useEffect(() => {
    if (
      recordingMode === "camera" &&
      !selectedCameraId &&
      availableCameras.length > 0
    ) {
      setSelectedCameraId(availableCameras[0]?.deviceId ?? null);
    }
  }, [recordingMode, selectedCameraId, availableCameras]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const storedRemember = window.localStorage.getItem(REMEMBER_DEVICES_KEY);
      if (storedRemember === "true") {
        setRememberDevices(true);
      }
    } catch (error) {
      console.error("Failed to load recorder preferences", error);
    }
  }, []);

  useEffect(() => {
    if (!open || !rememberDevices) return;
    if (typeof window === "undefined") return;

    try {
      const storedCameraId = window.localStorage.getItem(PREFERRED_CAMERA_KEY);
      if (storedCameraId) {
        const hasCamera = availableCameras.some(
          (camera) => camera.deviceId === storedCameraId
        );
        if (hasCamera && storedCameraId !== selectedCameraId) {
          setSelectedCameraId(storedCameraId);
        }
      }

      const storedMicId = window.localStorage.getItem(PREFERRED_MICROPHONE_KEY);
      if (storedMicId) {
        const hasMic = availableMics.some(
          (microphone) => microphone.deviceId === storedMicId
        );
        if (hasMic && storedMicId !== selectedMicId) {
          setSelectedMicId(storedMicId);
        }
      }
    } catch (error) {
      console.error("Failed to restore recorder device selection", error);
    }
  }, [
    open,
    rememberDevices,
    availableCameras,
    availableMics,
    selectedCameraId,
    selectedMicId,
  ]);

  const {
    isRecording,
    isBusy,
    canStartRecording,
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

  const handleCameraChange = (cameraId: string | null) => {
    setSelectedCameraId(cameraId);

    if (!rememberDevices || typeof window === "undefined") {
      return;
    }

    try {
      if (cameraId) {
        window.localStorage.setItem(PREFERRED_CAMERA_KEY, cameraId);
      } else {
        window.localStorage.removeItem(PREFERRED_CAMERA_KEY);
      }
    } catch (error) {
      console.error("Failed to persist preferred camera", error);
    }
  };

  const handleMicChange = (micId: string | null) => {
    setSelectedMicId(micId);

    if (!rememberDevices || typeof window === "undefined") {
      return;
    }

    try {
      if (micId) {
        window.localStorage.setItem(PREFERRED_MICROPHONE_KEY, micId);
      } else {
        window.localStorage.removeItem(PREFERRED_MICROPHONE_KEY);
      }
    } catch (error) {
      console.error("Failed to persist preferred microphone", error);
    }
  };

  const handleRememberDevicesChange = (next: boolean) => {
    setRememberDevices(next);

    if (typeof window === "undefined") {
      return;
    }

    try {
      window.localStorage.setItem(REMEMBER_DEVICES_KEY, next ? "true" : "false");

      if (next) {
        if (selectedCameraId) {
          window.localStorage.setItem(PREFERRED_CAMERA_KEY, selectedCameraId);
        } else {
          window.localStorage.removeItem(PREFERRED_CAMERA_KEY);
        }

        if (selectedMicId) {
          window.localStorage.setItem(PREFERRED_MICROPHONE_KEY, selectedMicId);
        } else {
          window.localStorage.removeItem(PREFERRED_MICROPHONE_KEY);
        }
      } else {
        window.localStorage.removeItem(PREFERRED_CAMERA_KEY);
        window.localStorage.removeItem(PREFERRED_MICROPHONE_KEY);
      }
    } catch (error) {
      console.error("Failed to update recorder preferences", error);
    }
  };

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
          onPointerDownOutside={(event) => {
            const originalEvent = event.detail.originalEvent as
              | PointerEvent
              | undefined;
            const target = originalEvent?.target as Element | undefined;

            if (!target) return;

            if (isRecording || isBusy) {
              event.preventDefault();
              return;
            }

            const path = originalEvent?.composedPath() || [];
            const dialogContent = dialogContentRef.current;

            const isInsideDialog = (el: Element) => {
              if (!dialogContent) return false;
              return dialogContent.contains(el);
            };

            const isWhitelisted = (el: Element) => {
              if (isInsideDialog(el)) return true;
              if (el.closest('[data-slot="select-content"]')) return true;
              if (el.closest("[data-radix-select-content]")) return true;
              if (el.closest("[data-radix-select-viewport]")) return true;
              if (el.closest("[data-radix-select-item]")) return true;
              if (el.closest("[data-camera-preview]")) return true;
              return false;
            };

            if (
              (target && isWhitelisted(target)) ||
              path.some(
                (t) => t instanceof Element && isWhitelisted(t as Element)
              )
            ) {
              event.preventDefault();
            }
          }}
          onFocusOutside={(event) => {
            const target = event.target as Element | undefined;

            if (!target) return;

            if (isRecording || isBusy) {
              event.preventDefault();
              return;
            }

            const path =
              (event.detail?.originalEvent as FocusEvent)?.composedPath?.() ||
              [];
            const dialogContent = dialogContentRef.current;

            const isInsideDialog = (el: Element) => {
              if (!dialogContent) return false;
              return dialogContent.contains(el);
            };

            const isWhitelisted = (el: Element) => {
              if (isInsideDialog(el)) return true;
              if (el.closest('[data-slot="select-content"]')) return true;
              if (el.closest("[data-radix-select-content]")) return true;
              if (el.closest("[data-radix-select-viewport]")) return true;
              if (el.closest("[data-radix-select-item]")) return true;
              if (el.closest("[data-camera-preview]")) return true;
              return false;
            };

            if (
              (target && isWhitelisted(target)) ||
              path.some(
                (t) => t instanceof Element && isWhitelisted(t as Element)
              )
            ) {
              event.preventDefault();
            }
          }}
          onInteractOutside={(event) => {
            const originalEvent = event.detail.originalEvent as
              | Event
              | undefined;
            const target = originalEvent?.target as Element | undefined;

            if (!target) return;

            if (isRecording || isBusy) {
              event.preventDefault();
              return;
            }

            const path = originalEvent?.composedPath?.() || [];
            const dialogContent = dialogContentRef.current;

            const isInsideDialog = (el: Element) => {
              if (!dialogContent) return false;
              return dialogContent.contains(el);
            };

            const isWhitelisted = (el: Element) => {
              if (isInsideDialog(el)) return true;
              if (el.closest('[data-slot="select-content"]')) return true;
              if (el.closest("[data-radix-select-content]")) return true;
              if (el.closest("[data-radix-select-viewport]")) return true;
              if (el.closest("[data-radix-select-item]")) return true;
              if (el.closest("[data-camera-preview]")) return true;
              return false;
            };

            if (
              (target && isWhitelisted(target)) ||
              path.some(
                (t) => t instanceof Element && isWhitelisted(t as Element)
              )
            ) {
              event.preventDefault();
            }
          }}
        >
          <DialogTitle className="sr-only">Instant Mode Recorder</DialogTitle>
          <AnimatePresence mode="wait">
            {open && (
              <motion.div
                variants={dialogVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                className="relative flex justify-center flex-col p-[1rem] gap-[0.75rem] text-[0.875rem] font-[400] text-[--text-primary] bg-gray-2 rounded-lg min-h-[340px]"
              >
                {!settingsOpen && (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Open recorder settings"
                    className="absolute right-3 top-3 z-10"
                    onClick={() => {
                      setSettingsOpen(true);
                      setHowItWorksOpen(false);
                    }}
                  >
                    <CogIcon size={20} aria-hidden className="text-gray-12" />
                  </Button>
                )}
                <AnimatePresence mode="wait">
                  {settingsOpen && (
                    <motion.div
                      key="web-recorder-settings"
                      initial={{ opacity: 0, y: -12 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -12 }}
                      transition={{ duration: 0.2, ease: "easeOut" }}
                      className="absolute inset-0 z-40 flex flex-col gap-4 p-4 border border-gray-3 rounded-lg bg-gray-1 shadow-lg dark:bg-gray-2"
                    >
                      <div className="flex items-center justify-between">
                        <button
                          type="button"
                          onClick={() => setSettingsOpen(false)}
                          className="flex items-center gap-1 text-sm font-medium text-gray-11 transition-colors hover:text-gray-12"
                        >
                          <ArrowLeftIcon className="size-4" />
                          Back
                        </button>
                        <h2 className="text-sm font-semibold text-gray-12">
                          Recorder settings
                        </h2>
                        <span className="w-9 h-9" aria-hidden />
                      </div>
                      <div className="flex flex-col gap-3">
                        <div className="flex gap-4 justify-between items-start p-4 text-left rounded-xl border border-gray-3 bg-gray-1 dark:bg-gray-3">
                          <div className="flex flex-col gap-1 text-left">
                            <p className="text-sm font-medium text-gray-12">
                              Remember selected webcam/microphone
                            </p>
                            <p className="text-xs text-gray-10">
                              Automatically pick your last camera and mic when available.
                            </p>
                          </div>
                          <Switch
                            checked={rememberDevices}
                            onCheckedChange={handleRememberDevicesChange}
                            aria-label="Remember selected devices"
                          />
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
                <AnimatePresence mode="wait">
                  {howItWorksOpen && (
                    <motion.div
                      key="web-recorder-how-it-works"
                      initial={{ opacity: 0, y: -12 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -12 }}
                      transition={{ duration: 0.2, ease: "easeOut" }}
                      className="absolute inset-0 z-40 flex flex-col gap-4 p-4 border border-gray-3 rounded-lg bg-gray-1 shadow-lg dark:bg-gray-2"
                    >
                      <div className="flex items-center justify-between">
                        <button
                          type="button"
                          onClick={() => setHowItWorksOpen(false)}
                          className="flex items-center gap-1 text-sm font-medium text-gray-11 transition-colors hover:text-gray-12"
                        >
                          <ArrowLeftIcon className="size-4" />
                          Back
                        </button>
                        <h2 className="text-sm font-semibold text-gray-12">
                          How it works
                        </h2>
                        <span className="w-9 h-9" aria-hidden />
                      </div>
                      <div className="flex flex-col gap-3 text-sm text-gray-11">
                        <p>
                          If you&apos;re on a compatible browser, we upload your recording
                          in the background while you capture.
                        </p>
                        <p>
                          When you stop, we finish processing instantly so you can grab a
                          shareable link right away.
                        </p>
                        <p>
                          Selecting a camera enables picture-in-picture so your webcam
                          stays visible during the recording. For the best experience with
                          picture-in-picture, record in fullscreen.
                        </p>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
                <WebRecorderDialogHeader
                  isBusy={isBusy}
                  onClose={handleClose}
                />
                <RecordingModeSelector
                  mode={recordingMode}
                  disabled={isBusy}
                  onModeChange={setRecordingMode}
                />
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
                <button
                  type="button"
                  onClick={() => {
                    setHowItWorksOpen(true);
                    setSettingsOpen(false);
                  }}
                  className="flex items-center justify-center gap-1 text-xs font-medium text-blue-11 transition-colors hover:text-blue-12"
                >
                  <CircleHelpIcon className="size-3.5" aria-hidden />
                  How does it work?
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </DialogContent>
      </Dialog>
      {selectedCameraId && (
        <CameraPreviewWindow
          cameraId={selectedCameraId}
          onClose={() => handleCameraChange(null)}
        />
      )}
    </>
  );
};
