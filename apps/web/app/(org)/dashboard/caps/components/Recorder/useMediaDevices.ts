"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";

type MediaDevice = {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
};

type PermissionStatus = "granted" | "denied" | "prompt" | "checking";

export function useMediaDevices() {
  const [availableCameras, setAvailableCameras] = useState<MediaDevice[]>([]);
  const [availableMicrophones, setAvailableMicrophones] = useState<MediaDevice[]>([]);
  const [micPermission, setMicPermission] = useState<PermissionStatus>("checking");
  const [cameraPermission, setCameraPermission] = useState<PermissionStatus>("checking");

  const enumerateDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();

      const cameras = devices
        .filter((device) => device.kind === "videoinput")
        .map((device) => ({
          deviceId: device.deviceId,
          label: device.label || `Camera ${device.deviceId.slice(0, 8)}`,
          kind: device.kind,
        }));

      const microphones = devices
        .filter((device) => device.kind === "audioinput")
        .map((device) => ({
          deviceId: device.deviceId,
          label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`,
          kind: device.kind,
        }));

      setAvailableCameras(cameras);
      setAvailableMicrophones(microphones);
    } catch (error) {
      console.error("Failed to enumerate devices:", error);
    }
  }, []);

  const checkPermissions = useCallback(async () => {
    try {
      const micPermResult = await navigator.permissions.query({
        name: "microphone" as PermissionName,
      });
      setMicPermission(micPermResult.state as PermissionStatus);

      const camPermResult = await navigator.permissions.query({
        name: "camera" as PermissionName,
      });
      setCameraPermission(camPermResult.state as PermissionStatus);

      micPermResult.addEventListener("change", () => {
        setMicPermission(micPermResult.state as PermissionStatus);
      });

      camPermResult.addEventListener("change", () => {
        setCameraPermission(camPermResult.state as PermissionStatus);
      });
    } catch {
      setMicPermission("prompt");
      setCameraPermission("prompt");
    }

    await enumerateDevices();
  }, [enumerateDevices]);

  const requestMicPermission = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      for (const track of stream.getTracks()) {
        track.stop();
      }
      setMicPermission("granted");
      await enumerateDevices();
      return true;
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };
      if (
        e?.name === "NotAllowedError" ||
        e?.name === "PermissionDeniedError"
      ) {
        setMicPermission("denied");
        toast.error(
          "Microphone permission denied. Please allow microphone access in your browser settings and try again."
        );
      } else {
        toast.error(
          "Failed to access microphone: " + (e?.message ?? "Unknown error")
        );
      }
      return false;
    }
  }, [enumerateDevices]);

  const requestCameraPermission = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
      });
      for (const track of stream.getTracks()) {
        track.stop();
      }
      setCameraPermission("granted");
      await enumerateDevices();
      return true;
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };
      if (
        e?.name === "NotAllowedError" ||
        e?.name === "PermissionDeniedError"
      ) {
        setCameraPermission("denied");
        toast.error(
          "Camera permission denied. Please allow camera access in your browser settings and try again."
        );
      } else {
        toast.error(
          "Failed to access camera: " + (e?.message ?? "Unknown error")
        );
      }
      return false;
    }
  }, [enumerateDevices]);

  return {
    availableCameras,
    availableMicrophones,
    micPermission,
    cameraPermission,
    checkPermissions,
    requestMicPermission,
    requestCameraPermission,
  };
}