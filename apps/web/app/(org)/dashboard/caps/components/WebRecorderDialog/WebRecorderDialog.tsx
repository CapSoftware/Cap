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

export const WebRecorderDialog = () => {
  const [open, setOpen] = useState(false);
  const [selectedMicId, setSelectedMicId] = useState<string | null>(null);
  const [recordingMode, setRecordingMode] =
    useState<RecordingMode>("fullscreen");
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
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
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogTrigger asChild>
          <Button variant="dark" size="sm" className="flex items-center gap-2">
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
                  onCameraChange={handleCameraChange}
                  onRefreshDevices={refreshCameras}
                />
                <MicrophoneSelector
                  selectedMicId={selectedMicId}
                  availableMics={availableMics}
                  dialogOpen={open}
                  disabled={isBusy}
                  onMicChange={setSelectedMicId}
                  onRefreshDevices={refreshMics}
                />
                <RecordingButton
                  isRecording={isRecording}
                  disabled={!canStartRecording || (isBusy && !isRecording)}
                  onStart={startRecording}
                  onStop={handleStopClick}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </DialogContent>
      </Dialog>
      {selectedCameraId && (
        <CameraPreviewWindow
          cameraId={selectedCameraId}
          onClose={() => setSelectedCameraId(null)}
        />
      )}
    </>
  );
};
