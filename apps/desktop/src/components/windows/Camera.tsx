import { Preview } from "@/components/recording/Preview";
import { setWindowPosition } from "@/utils/helpers";
import { useMediaDevices } from "@/utils/recording/MediaDeviceContext";
import { ReactMediaRecorder } from "@/utils/recording/client";
import { useRef } from "react";

export const Camera = () => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { selectedVideoDevice } = useMediaDevices();
  setWindowPosition("bottom_right");

  console.log("selected video2:");
  console.log(selectedVideoDevice);

  return (
    <div className="w-full h-full">
      <ReactMediaRecorder
        audio={true}
        video={
          selectedVideoDevice
            ? { deviceId: selectedVideoDevice.deviceId }
            : true
        }
        render={({ previewStream }) => {
          console.log("previewStream:");
          console.log(previewStream);
          if (videoRef.current) {
            console.log("video ref:");
            console.log(videoRef.current.srcObject);
            videoRef.current.srcObject = previewStream || null;
          }

          return <Preview videoRef={videoRef} />;
        }}
      />
    </div>
  );
};
