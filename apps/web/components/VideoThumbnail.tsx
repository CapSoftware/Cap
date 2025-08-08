import { useUploadingContext } from "@/app/(org)/dashboard/caps/UploadingContext";
import { LogoSpinner } from "@cap/ui";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import Image from "next/image";
import { memo, useEffect, useRef, useState } from "react";

interface VideoThumbnailProps {
  userId: string;
  videoId: string;
  alt: string;
  imageClass?: string;
  objectFit?: string;
  containerClass?: string;
}

function generateRandomGrayScaleColor() {
  const minGrayScaleValue = 190;
  const maxGrayScaleValue = 235;
  const grayScaleValue = Math.floor(
    Math.random() * (maxGrayScaleValue - minGrayScaleValue) + minGrayScaleValue
  );
  return `rgb(${grayScaleValue}, ${grayScaleValue}, ${grayScaleValue})`;
}

export const VideoThumbnail: React.FC<VideoThumbnailProps> = memo(
  ({
    userId,
    videoId,
    alt,
    imageClass,
    objectFit = "cover",
    containerClass,
  }) => {
    const imageUrl = useQuery({
      queryKey: ["thumbnail", userId, videoId],
      queryFn: async () => {
        const cacheBuster = new Date().getTime();
        const response = await fetch(
          `/api/thumbnail?userId=${userId}&videoId=${videoId}&t=${cacheBuster}`
        );
        if (response.ok) {
          const data = await response.json();
          // Add cache busting to the thumbnail URL as well
          return `${data.screen}${data.screen.includes("?") ? "&" : "?"
            }t=${cacheBuster}`;
        } else {
          throw new Error("Failed to fetch pre-signed URLs");
        }
      },
    });
    const imageRef = useRef<HTMLImageElement>(null);

    const { uploadingCapId } = useUploadingContext();

    useEffect(() => {
      imageUrl.refetch();
    }, [imageUrl.refetch, uploadingCapId]);

    const randomGradient = `linear-gradient(to right, ${generateRandomGrayScaleColor()}, ${generateRandomGrayScaleColor()})`;

    const [imageStatus, setImageStatus] = useState<
      "loading" | "error" | "success"
    >("loading");

    useEffect(() => {
      if (imageRef.current?.complete && imageRef.current.naturalWidth != 0) {
        setImageStatus("success");
      }
    }, []);

    return (
      <div
        className={clsx(
          `overflow-hidden relative mx-auto w-full h-full bg-black rounded-t-xl border-b border-gray-3 aspect-video`,
          containerClass
        )}
      >
        <div className="flex absolute inset-0 z-10 justify-center items-center">
          {imageUrl.isError || imageStatus === "error" ? (
            <div
              className="w-full h-full"
              style={{ backgroundImage: randomGradient }}
            />
          ) : (
            (imageUrl.isPending || imageStatus === "loading") && (
              <LogoSpinner className="w-5 h-auto animate-spin md:w-8" />
            )
          )}
        </div>
        {imageUrl.data && (
          <Image
            ref={imageRef}
            src={imageUrl.data}
            fill={true}
            sizes="(max-width: 768px) 100vw, 33vw"
            alt={alt}
            key={videoId}
            style={{ objectFit: objectFit as any }}
            className={clsx(
              "w-full h-full",
              imageClass,
              imageStatus === "loading" && "opacity-0"
            )}
            onLoad={() => setImageStatus("success")}
            onError={() => setImageStatus("error")}
          />
        )}
      </div>
    );
  }
);
