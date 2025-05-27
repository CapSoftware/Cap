"use client";

import { useRef, useState } from "react";
import { Button } from "@cap/ui";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { uploadToS3 } from "@/utils/video/upload/helpers";
import { useRouter } from "next/navigation";

export const UploadCapButton = ({
  onStart,
  onProgress,
  onComplete,
}: {
  onStart?: (id: string, thumbnail?: string) => void;
  onProgress?: (id: string, progress: number) => void;
  onComplete?: (id: string) => void;
}) => {
  const { user, isSubscribed } = useSharedContext();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const router = useRouter();

  if (!isSubscribed) return null;

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    setUploading(true);
    try {
      const parser = await import("@remotion/media-parser");
      const webcodecs = await import("@remotion/webcodecs");

      const captureThumbnail = (): Promise<Blob> => {
        return new Promise((resolve, reject) => {
          const video = document.createElement("video");
          video.src = URL.createObjectURL(file);
          video.muted = true;
          video.playsInline = true;
          video.currentTime = 0;
          video.addEventListener("loadeddata", () => {
            try {
              const canvas = document.createElement("canvas");
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
              const ctx = canvas.getContext("2d");
              ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
              canvas.toBlob((blob) => {
                if (blob) resolve(blob);
                else reject(new Error("Failed to create thumbnail"));
                URL.revokeObjectURL(video.src);
              }, "image/jpeg");
            } catch (err) {
              reject(err);
            }
          });
          video.addEventListener("error", (err) => reject(err));
        });
      };

      const metadata = await parser.parseMedia({
        src: file,
        fields: { durationInSeconds: true, dimensions: true },
      });

      const uploadId = crypto.randomUUID();
      const thumbnailBlob = await captureThumbnail();
      const thumbnailUrl = URL.createObjectURL(thumbnailBlob);
      onStart?.(uploadId, thumbnailUrl);
      onProgress?.(uploadId, 10);

      const controller = parser.mediaParserController
        ? parser.mediaParserController()
        : undefined;

      const convertResult = await webcodecs.convertMedia({
        src: file,
        container: "mp4",
        videoCodec: "h264",
        controller: controller as any,
        expectedDurationInSeconds: metadata.durationInSeconds || undefined,
      });

      const optimizedBlob = await convertResult.save();
      onProgress?.(uploadId, 40);

      const duration = metadata.durationInSeconds
        ? Math.round(metadata.durationInSeconds).toString()
        : undefined;

      const createResp = await fetch(
        `/api/desktop/video/create?recordingMode=desktopMP4&videoId=${uploadId}${
          duration ? `&duration=${duration}` : ""
        }`
      );
      const createData = await createResp.json();

      const fileKey = `${user.id}/${createData.id}/result.mp4`;

      await uploadToS3({
        filename: fileKey,
        blobData: optimizedBlob,
        userId: user.id,
        duration,
        resolution: metadata.dimensions
          ? `${metadata.dimensions.width}x${metadata.dimensions.height}`
          : undefined,
        videoCodec: "h264",
        audioCodec: "aac",
        awsBucket: createData.aws_bucket,
        awsRegion: createData.aws_region,
        onProgress: (p) => onProgress?.(uploadId, 40 + p * 0.5),
      });

      const screenshotResp = await fetch(
        `/api/desktop/video/create?recordingMode=desktopMP4&videoId=${uploadId}&isScreenshot=true`
      );
      const screenshotData = await screenshotResp.json();

      await uploadToS3({
        filename: `${user.id}/${createData.id}/screenshot/screen-capture.jpg`,
        blobData: thumbnailBlob,
        userId: user.id,
        awsBucket: screenshotData.aws_bucket,
        awsRegion: screenshotData.aws_region,
        onProgress: (p) => onProgress?.(uploadId, 90 + p * 0.1),
      });

      onProgress?.(uploadId, 100);
      onComplete?.(uploadId);
      router.refresh();
    } catch (err) {
      console.error("Video upload failed", err);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <>
      <Button onClick={handleClick} disabled={uploading} variant="primary" size="sm">
        {uploading ? "Uploading..." : "Upload Video"}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        onChange={handleChange}
        className="hidden"
      />
    </>
  );
};
