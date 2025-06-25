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

    useEffect(() => {
      const fetchPreSignedUrls = async () => {
        try {
          const response = await fetch(
            `/api/thumbnail?userId=${userId}&videoId=${videoId}`
          );
          if (response.ok) {
            const data = await response.json();
            setImageUrls({ screen: data.screen });
          } else {
            console.error("Failed to fetch pre-signed URLs");
          }
        } catch (error) {
          console.error("Error fetching pre-signed URLs:", error);
        }
      };

      fetchPreSignedUrls();
    }, [userId, videoId]);

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
            layout="fill"
            alt={alt}
            objectFit={objectFit}
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
