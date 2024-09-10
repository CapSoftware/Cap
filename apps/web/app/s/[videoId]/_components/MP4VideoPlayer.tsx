import { memo, forwardRef, useRef, useImperativeHandle } from "react";

interface MP4VideoPlayerProps {
  videoSrc: string;
}

export const MP4VideoPlayer = memo(
  forwardRef<HTMLVideoElement, MP4VideoPlayerProps>(({ videoSrc }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);

    useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement);

    return (
      <video
        id="video-player"
        ref={videoRef}
        className="absolute top-0 left-0 rounded-lg w-full h-full object-contain"
        preload="metadata"
        playsInline
        controls={false}
        muted
      >
        <source src={videoSrc} type="video/mp4" />
      </video>
    );
  })
);
