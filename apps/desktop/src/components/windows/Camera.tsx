import { useEffect, useRef, useState } from "react";
import { useMediaDevices } from "@/utils/recording/MediaDeviceContext";

export const Camera = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { selectedVideoDevice } = useMediaDevices();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let activeStream: MediaStream | null = null;

    async function setupCamera() {
      if (!videoRef.current || !selectedVideoDevice) {
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(
          (device) => device.kind === "videoinput"
        );
        const deviceId = videoDevices[selectedVideoDevice.index].deviceId;

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: deviceId,
            frameRate: { ideal: 30 },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });

        // Ensure videoRef.current is still not null
        if (!videoRef.current) return;

        videoRef.current.srcObject = stream;
        videoRef.current.onplaying = () => setIsLoading(false);
        await videoRef.current.play();

        // Save stream for cleanup
        activeStream = stream;
      } catch (err) {
        console.error(err);
        setIsLoading(false);
      }
    }

    setupCamera();

    return () => {
      if (activeStream) {
        activeStream.getTracks().forEach((track) => track.stop());
        activeStream = null;
      }
      setIsLoading(false);
    };
  }, [selectedVideoDevice]);

  return (
    <div
      data-tauri-drag-region
      className="w-[200px] h-[200px] bg-gray-200 rounded-full m-0 p-0 relative overflow-hidden flex items-center justify-center"
    >
      {isLoading ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          stroke="#fff"
          viewBox="0 0 38 38"
          className="w-24 h-24"
        >
          <g
            fill="none"
            fillRule="evenodd"
            strokeWidth="2"
            transform="translate(1 1)"
          >
            <circle cx="18" cy="18" r="18" strokeOpacity="0.4"></circle>
            <path d="M36 18c0-9.94-8.06-18-18-18">
              <animateTransform
                attributeName="transform"
                dur="1s"
                from="0 18 18"
                repeatCount="indefinite"
                to="360 18 18"
                type="rotate"
              ></animateTransform>
            </path>
          </g>
        </svg>
      ) : (
        <video
          ref={videoRef}
          autoPlay
          muted
          className="absolute top-0 left-0 w-full h-full object-cover pointer-events-none"
        />
      )}
    </div>
  );
};
