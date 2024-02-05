import Image from "next/image";
import { useEffect, useState } from "react";

// Define your props interface
interface VideoThumbnailProps {
  userId: string;
  videoId: string;
  alt: string;
}

export const VideoThumbnail = ({
  userId,
  videoId,
  alt,
}: VideoThumbnailProps) => {
  const [imageUrls, setImageUrls] = useState({ screen: "", video: "" });
  const [loading, setLoading] = useState(true);

  // Fetch the pre-signed URLs on component mount
  useEffect(() => {
    const fetchPreSignedUrls = async () => {
      try {
        const response = await fetch(
          `/api/thumbnail?userId=${userId}&videoId=${videoId}`
        );
        if (response.ok) {
          const data = await response.json();
          setImageUrls({ screen: data.screen, video: data.video });
        } else {
          console.error("Failed to fetch pre-signed URLs");
        }
      } catch (error) {
        console.error("Error fetching pre-signed URLs:", error);
      }
      setLoading(false);
    };

    fetchPreSignedUrls();
  }, [userId, videoId]);

  return (
    <div
      className={`aspect-video relative overflow-hidden rounded-lg ${
        loading ? "bg-gray-200" : "bg-black"
      }`}
    >
      {imageUrls.video && (
        <div className="absolute bottom-2 right-2 w-[50px] h-[50px] z-10 rounded-full overflow-hidden">
          <Image
            src={imageUrls.video}
            alt="Video Thumbnail"
            layout="fill"
            objectFit="cover"
            className="w-full h-full"
            onLoadingComplete={() => setLoading(false)}
          />
        </div>
      )}
      {imageUrls.screen && (
        <Image
          src={imageUrls.screen}
          alt={alt}
          layout="fill"
          objectFit="cover"
          className="group-hover:scale-[1.02] transition-all w-full h-full"
          onLoadingComplete={() => setLoading(false)}
        />
      )}
      <div className="bg-black opacity-0 z-10 absolute top-0 left-0 w-full h-full group-hover:opacity-50 transition-all"></div>
    </div>
  );
};
