"use client";

import {
  SelectRoot,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@cap/ui";
import clsx from "clsx";
import { CameraIcon, CameraOffIcon } from "lucide-react";
import { toast } from "sonner";
import { NO_CAMERA, NO_CAMERA_VALUE } from "./web-recorder-constants";
import { useMediaPermission } from "./useMediaPermission";

import type { KeyboardEvent, MouseEvent } from "react";

interface CameraSelectorProps {
  selectedCameraId: string | null;
  availableCameras: MediaDeviceInfo[];
  dialogOpen: boolean;
  disabled?: boolean;
  onCameraChange: (cameraId: string | null) => void;
  onRefreshDevices: () => Promise<void> | void;
}

export const CameraSelector = ({
  selectedCameraId,
  availableCameras,
  dialogOpen,
  disabled = false,
  onCameraChange,
  onRefreshDevices,
}: CameraSelectorProps) => {
  const cameraEnabled = selectedCameraId !== null;
  const { state: permissionState, requestPermission } = useMediaPermission(
    "camera",
    dialogOpen
  );

  const permissionSupported = permissionState !== "unsupported";
  const shouldRequestPermission =
    permissionSupported && permissionState !== "granted";

  const statusPillClassName = clsx(
    "px-[0.375rem] h-[1.25rem] min-w-[2.5rem] rounded-full text-[0.75rem] leading-[1.25rem] flex items-center justify-center font-normal transition-colors duration-200 disabled:opacity-100 disabled:pointer-events-none",
    shouldRequestPermission
      ? "bg-[var(--red-3)] text-[var(--red-11)] dark:bg-[var(--red-4)] dark:text-[var(--red-12)]"
      : cameraEnabled
      ? "bg-[var(--blue-3)] text-[var(--blue-11)] dark:bg-[var(--blue-4)] dark:text-[var(--blue-12)]"
      : "bg-[var(--red-3)] text-[var(--red-11)] dark:bg-[var(--red-4)] dark:text-[var(--red-12)]"
  );

  const handleStatusPillClick = async (
    event: MouseEvent<HTMLButtonElement>
  ) => {
    if (!shouldRequestPermission) return;
    event.preventDefault();
    event.stopPropagation();

    try {
      const granted = await requestPermission();
      if (granted) {
        await Promise.resolve(onRefreshDevices());
      }
    } catch (error) {
      console.error("Camera permission request failed", error);
      toast.error("Unable to access your camera. Check browser permissions.");
    }
  };

  return (
    <div className="flex flex-col gap-[0.25rem] items-stretch text-[--text-primary]">
      <SelectRoot
        value={selectedCameraId ?? NO_CAMERA_VALUE}
        onValueChange={(value) => {
          onCameraChange(value === NO_CAMERA_VALUE ? null : value);
        }}
        disabled={disabled}
      >
        <SelectTrigger
          className={clsx(
            "relative flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border border-gray-3 rounded-lg w-full transition-colors overflow-hidden z-10 font-normal text-[0.875rem] bg-transparent hover:bg-transparent focus:bg-transparent focus:border-gray-3 hover:border-gray-3 text-[--text-primary] disabled:text-gray-11 [&>svg]:hidden",
            disabled || shouldRequestPermission ? "cursor-default" : undefined
          )}
          onPointerDown={(event) => {
            if (shouldRequestPermission) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
            if (shouldRequestPermission) {
              const keys = ["Enter", " ", "ArrowDown", "ArrowUp"];
              if (keys.includes(event.key)) {
                event.preventDefault();
                event.stopPropagation();
              }
            }
          }}
          aria-disabled={disabled || shouldRequestPermission}
        >
          <SelectValue
            placeholder={NO_CAMERA}
            className="flex-1 flex items-center gap-[0.375rem] truncate"
          />
          <button
            type="button"
            className={statusPillClassName}
            disabled={!shouldRequestPermission}
            onClick={handleStatusPillClick}
          >
            {shouldRequestPermission
              ? "Request permission"
              : cameraEnabled
              ? "On"
              : "Off"}
          </button>
        </SelectTrigger>
        <SelectContent className="z-[502]">
          <SelectItem value={NO_CAMERA_VALUE}>
            <span className="flex items-center gap-2 truncate">
              <CameraOffIcon className="size-4 text-gray-11" />
              {NO_CAMERA}
            </span>
          </SelectItem>
          {availableCameras.map((camera, index) => (
            <SelectItem key={camera.deviceId} value={camera.deviceId}>
              <span className="flex items-center gap-2 truncate">
                <CameraIcon className="size-4 text-gray-11" />
                {camera.label?.trim() || `Camera ${index + 1}`}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </SelectRoot>
    </div>
  );
};
