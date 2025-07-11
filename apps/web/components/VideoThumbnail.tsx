import { useUploadingContext } from "@/app/(org)/dashboard/caps/UploadingContext";
import { LogoSpinner } from "@cap/ui";
import clsx from "clsx";
import Image from "next/image";
import { memo, useEffect, useState } from "react";

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
    const [imageUrls, setImageUrls] = useState({ screen: "" });
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);
    const { uploadingCapId } = useUploadingContext()

    useEffect(() => {
      // Reset states when videoId changes
      setLoading(true);
      setFailed(false);

      const fetchPreSignedUrls = async () => {
        try {
          // Add cache busting parameter to ensure we get fresh thumbnails
          const cacheBuster = new Date().getTime();
          const response = await fetch(
            `/api/thumbnail?userId=${userId}&videoId=${videoId}&t=${cacheBuster}`
          );
          if (response.ok) {
            const data = await response.json();
            // Add cache busting to the thumbnail URL as well
            setImageUrls({ screen: `${data.screen}${data.screen.includes('?') ? '&' : '?'}t=${cacheBuster}` });
          } else {
            console.error("Failed to fetch pre-signed URLs");
            setFailed(true);
          }
        } catch (error) {
          console.error("Error fetching pre-signed URLs:", error);
          setFailed(true);
        } finally {
          // If we couldn't fetch the URL, we should stop showing the spinner
          if (!imageUrls.screen) {
            setLoading(false);
          }
        }
      };

      fetchPreSignedUrls();
    }, [userId, videoId, uploadingCapId]);

    const randomGradient = `linear-gradient(to right, ${generateRandomGrayScaleColor()}, ${generateRandomGrayScaleColor()})`;

    return (
      <div
        className={clsx(
          `overflow-hidden relative mx-auto w-full h-full bg-black rounded-t-xl border-b border-gray-3 aspect-video`,
          containerClass
        )}
      >
        <div className="flex absolute top-0 left-0 z-10 justify-center items-center w-full h-full">
          {failed ? (
            <div
              className="w-full h-full"
              style={{ backgroundImage: randomGradient }}
            ></div>
          ) : (
            loading === true && (
              <LogoSpinner className="w-5 h-auto animate-spin md:w-8" />
            )
          )}
        </div>
        {imageUrls.screen && (
          <Image
            src={imageUrls.screen}
            fill={true}
            sizes="(max-width: 768px) 100vw, 33vw"
            alt={alt}
            key={videoId}
            style={{ objectFit: objectFit as any }}
            className={clsx("w-full h-full", imageClass)}
            onLoad={() => setLoading(false)}
            onError={() => {
              setFailed(true);
              setLoading(false);
            }}
          />
        )}
      </div>
    );
  }
);
