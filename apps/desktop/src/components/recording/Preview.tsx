import { RefObject } from "react";

export type PreviewProps = {
  videoRef: RefObject<HTMLVideoElement> | null;
};

export const Preview = ({ videoRef }: PreviewProps) => {
  return (
    <div
      data-tauri-drag-region
      className="w-[200px] h-[200px] bg-gray-200 rounded-full m-0 p-0 relative overflow-hidden"
    >
      {videoRef !== null ? (
        <video
          ref={videoRef}
          autoPlay
          muted
          className="absolute top-0 left-0 w-full h-full object-cover pointer-events-none"
        />
      ) : (
        <p>Placeholder</p>
      )}
    </div>
  );
};
