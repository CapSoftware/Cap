import { LogoSpinner } from "@cap/ui";
import Image from "next/image";
import { useEffect, useState, memo } from "react";

interface VideoThumbnailProps {
  userId: string;
  videoId: string;
  alt: string;
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
  ({ userId, videoId, alt }) => {
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
        className={`aspect-video relative overflow-hidden rounded-tr-lg rounded-tl-lg bg-black`}
      >
        <div className="absolute top-0 left-0 flex items-center justify-center w-full h-full z-10">
          {failed ? (
            <div
              className="w-full h-full"
              style={{ backgroundImage: randomGradient }}
            ></div>
          ) : (
            loading === true && (
              <LogoSpinner className="w-5 md:w-8 h-auto animate-spin" />
            )
          )}
        </div>
        {imageUrls.screen && (
          <Image
            src={imageUrls.screen}
            alt={alt}
            layout="fill"
            objectFit="cover"
            className="group-hover:scale-[1.02] transition-all w-full h-full"
            onLoad={() => setLoading(false)}
            onError={() => {
              setFailed(true);
              setLoading(false);
            }}
          />
        )}
        <div className="bg-black opacity-0 z-10 absolute top-0 left-0 w-full h-full group-hover:opacity-50 transition-all"></div>
      </div>
    );
  }
);
