import { Preview } from "@/components/recording/Preview";
import { useMediaDevices } from "@/utils/recording/MediaDeviceContext";
import { ReactMediaRecorder } from "@/utils/recording/client";
import { useRef } from "react";

export const Camera = () => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { selectedVideoDevice } = useMediaDevices();

  return (
    <div className="w-full h-full">
      <ReactMediaRecorder
        video={
          selectedVideoDevice
            ? { deviceId: selectedVideoDevice.deviceId }
            : true
        }
        render={({ previewStream }) => {
          if (videoRef.current) {
            videoRef.current.srcObject = previewStream || null;
          }

          return <Preview videoRef={videoRef} />;
        }}
      />
    </div>
  );
};
