import { useEffect, useRef, useState } from "react";
import { useMediaDevices } from "@/utils/recording/MediaDeviceContext";

export const Camera = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { selectedVideoDevice } = useMediaDevices();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (videoRef.current && selectedVideoDevice) {
      setIsLoading(true);

      navigator.mediaDevices
        .enumerateDevices()
        .then((devices) => {
          const videoDevices = devices.filter(
            (device) => device.kind === "videoinput"
          );
          console.log("videoDevices:");
          console.log(videoDevices);
          return videoDevices[selectedVideoDevice.index].deviceId;
        })
        .then((deviceId) =>
          navigator.mediaDevices.getUserMedia({
            video: {
              deviceId: deviceId,
            },
          })
        )
        .then((stream) => {
          let video = videoRef.current;
          if (video) {
            video.srcObject = stream;
            console.log("video.srcObject:");
            console.log(video.srcObject);
            video.play();
          }
          setIsLoading(false);
        })
        .catch((err) => {
          console.error(err);
          setIsLoading(false);
        });

      setIsLoading(false);
    }
  }, [selectedVideoDevice, videoRef]);

  if (videoRef && selectedVideoDevice && isLoading === true) {
    setIsLoading(false);
  }

  return (
    <div
      data-tauri-drag-region
      className="w-[200px] h-[200px] bg-gray-200 rounded-full m-0 p-0 relative overflow-hidden flex items-center justify-center"
    >
      {isLoading === true ? (
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
