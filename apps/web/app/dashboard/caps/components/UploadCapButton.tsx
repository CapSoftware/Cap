"use client";

import { useRef, useState } from "react";
import { Button } from "@cap/ui";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { createVideoAndGetUploadUrl } from "@/actions/video/upload";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  getProgressCircleConfig,
  calculateStrokeDashoffset,
  getUploadStatus,
  getDisplayProgress,
  isUserOnProPlan,
} from "@cap/utils";
import { UpgradeModal } from "@/components/UpgradeModal";

export const UploadCapButton = ({
  onStart,
  onProgress,
  onComplete,
  grey = false,
}: {
  onStart?: (id: string, thumbnail?: string) => void;
  onProgress?: (id: string, progress: number, uploadProgress?: number) => void;
  onComplete?: (id: string) => void;
  grey?: boolean;
}) => {
  const { user, isSubscribed } = useSharedContext();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | undefined>(
    undefined
  );
  const [processingProgress, setProcessingProgress] = useState(0);
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const router = useRouter();

  const { circumference } = getProgressCircleConfig();
  const status = getUploadStatus(uploadProgress);
  const displayProgress = getDisplayProgress(
    uploadProgress,
    processingProgress
  );
  const strokeDashoffset = calculateStrokeDashoffset(
    displayProgress,
    circumference
  );

  const handleClick = () => {
    if (!user) return;

    const isCapPro = isUserOnProPlan({
      subscriptionStatus: user.stripeSubscriptionStatus,
    });

    if (!isCapPro) {
      setUpgradeModalOpen(true);
      return;
    }

    inputRef.current?.click();
  };

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    setUploading(true);
    setUploadProgress(undefined);
    setProcessingProgress(0);
    try {
      const parser = await import("@remotion/media-parser");
      const webcodecs = await import("@remotion/webcodecs");

      const metadata = await parser.parseMedia({
        src: file,
        fields: {
          durationInSeconds: true,
          dimensions: true,
          fps: true,
          numberOfAudioChannels: true,
          sampleRate: true,
        },
      });

      const duration = metadata.durationInSeconds
        ? Math.round(metadata.durationInSeconds)
        : undefined;

      const videoData = await createVideoAndGetUploadUrl({
        duration,
        resolution: metadata.dimensions
          ? `${metadata.dimensions.width}x${metadata.dimensions.height}`
          : undefined,
        videoCodec: "h264",
        audioCodec: "aac",
        isScreenshot: false,
        isUpload: true,
      });

      const uploadId = videoData.id;
      onStart?.(uploadId);
      onProgress?.(uploadId, 10);

      const fileSizeMB = file.size / (1024 * 1024);
      onProgress?.(uploadId, 15);

      let optimizedBlob: Blob;

      try {
        const calculateResizeOptions = () => {
          if (!metadata.dimensions) return undefined;

          const { width, height } = metadata.dimensions;
          const maxWidth = 1920;
          const maxHeight = 1080;

          if (width <= maxWidth && height <= maxHeight) {
            return undefined;
          }

          const widthScale = maxWidth / width;
          const heightScale = maxHeight / height;
          const scale = Math.min(widthScale, heightScale);

          return { mode: "scale" as const, scale };
        };

        const resizeOptions = calculateResizeOptions();

        const convertResult = await webcodecs.convertMedia({
          src: file,
          container: "mp4",
          videoCodec: "h264",
          audioCodec: "aac",
          ...(resizeOptions && { resize: resizeOptions }),
          onProgress: ({ overallProgress }) => {
            if (overallProgress !== null) {
              const progressValue = overallProgress * 100;
              setProcessingProgress(progressValue);
              onProgress?.(uploadId, progressValue);
            }
          },
        });
        optimizedBlob = await convertResult.save();

        if (optimizedBlob.size === 0) {
          throw new Error("Conversion produced empty file");
        }
        const isValidVideo = await new Promise<boolean>((resolve) => {
          const testVideo = document.createElement("video");
          testVideo.muted = true;
          testVideo.playsInline = true;
          testVideo.preload = "metadata";

          const timeout = setTimeout(() => {
            console.warn("Video validation timed out");
            URL.revokeObjectURL(testVideo.src);
            resolve(false);
          }, 15000);

          let metadataLoaded = false;

          const validateVideo = () => {
            if (metadataLoaded) return;
            metadataLoaded = true;

            const hasValidDuration =
              testVideo.duration > 0 &&
              !isNaN(testVideo.duration) &&
              isFinite(testVideo.duration);

            const hasValidDimensions =
              (testVideo.videoWidth > 0 && testVideo.videoHeight > 0) ||
              (metadata.dimensions &&
                metadata.dimensions.width > 0 &&
                metadata.dimensions.height > 0);

            if (hasValidDuration && hasValidDimensions) {
              clearTimeout(timeout);
              URL.revokeObjectURL(testVideo.src);
              resolve(true);
            } else {
              console.warn(
                `Invalid video properties - Duration: ${testVideo.duration}, Dimensions: ${testVideo.videoWidth}x${testVideo.videoHeight}, Original dimensions: ${metadata.dimensions?.width}x${metadata.dimensions?.height}`
              );
              clearTimeout(timeout);
              URL.revokeObjectURL(testVideo.src);
              resolve(false);
            }
          };

          testVideo.addEventListener("loadedmetadata", validateVideo);
          testVideo.addEventListener("loadeddata", validateVideo);
          testVideo.addEventListener("canplay", validateVideo);

          testVideo.addEventListener("error", (e) => {
            console.error("Video validation error:", e);
            clearTimeout(timeout);
            URL.revokeObjectURL(testVideo.src);
            resolve(false);
          });

          testVideo.addEventListener("loadstart", () => {});

          testVideo.src = URL.createObjectURL(optimizedBlob);
        });

        if (!isValidVideo) {
          throw new Error("Converted video is not playable");
        }
      } catch (conversionError) {
        console.error("Video conversion failed:", conversionError);
        toast.error(
          "Failed to process video file. This format may not be supported for upload."
        );
        return;
      }

      const captureThumbnail = (): Promise<Blob | null> => {
        return new Promise((resolve) => {
          const video = document.createElement("video");
          video.src = URL.createObjectURL(optimizedBlob);
          video.muted = true;
          video.playsInline = true;
          video.crossOrigin = "anonymous";

          const cleanup = () => {
            URL.revokeObjectURL(video.src);
          };

          const timeout = setTimeout(() => {
            cleanup();
            console.warn(
              "Thumbnail generation timed out, proceeding without thumbnail"
            );
            resolve(null);
          }, 10000);

          video.addEventListener("loadedmetadata", () => {
            try {
              const seekTime = Math.min(1, video.duration / 4);
              video.currentTime = seekTime;
            } catch (err) {
              console.warn("Failed to seek video for thumbnail:", err);
              clearTimeout(timeout);
              cleanup();
              resolve(null);
            }
          });

          video.addEventListener("seeked", () => {
            try {
              const canvas = document.createElement("canvas");
              canvas.width = video.videoWidth || 640;
              canvas.height = video.videoHeight || 480;
              const ctx = canvas.getContext("2d");
              if (!ctx) {
                console.warn("Failed to get canvas context");
                clearTimeout(timeout);
                cleanup();
                resolve(null);
                return;
              }
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              canvas.toBlob(
                (blob) => {
                  clearTimeout(timeout);
                  cleanup();
                  if (blob) {
                    resolve(blob);
                  } else {
                    console.warn("Failed to create thumbnail blob");
                    resolve(null);
                  }
                },
                "image/jpeg",
                0.8
              );
            } catch (err) {
              console.warn("Error during thumbnail capture:", err);
              clearTimeout(timeout);
              cleanup();
              resolve(null);
            }
          });

          video.addEventListener("error", (err) => {
            console.warn("Video loading error for thumbnail:", err);
            clearTimeout(timeout);
            cleanup();
            resolve(null);
          });

          video.addEventListener("loadstart", () => {});
        });
      };

      const thumbnailBlob = await captureThumbnail();
      const thumbnailUrl = thumbnailBlob
        ? URL.createObjectURL(thumbnailBlob)
        : undefined;

      onStart?.(uploadId, thumbnailUrl);
      onProgress?.(uploadId, 100);

      const formData = new FormData();
      Object.entries(videoData.presignedPostData.fields).forEach(
        ([key, value]) => {
          formData.append(key, value as string);
        }
      );
      formData.append("file", optimizedBlob);

      setUploadProgress(0);

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", videoData.presignedPostData.url);

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const percent = (event.loaded / event.total) * 100;
            setUploadProgress(percent);
            onProgress?.(uploadId, 100, percent);
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Upload failed with status ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error("Upload failed"));

        xhr.send(formData);
      });

      if (thumbnailBlob) {
        const screenshotData = await createVideoAndGetUploadUrl({
          videoId: uploadId,
          isScreenshot: true,
          isUpload: true,
        });

        const screenshotFormData = new FormData();
        Object.entries(screenshotData.presignedPostData.fields).forEach(
          ([key, value]) => {
            screenshotFormData.append(key, value as string);
          }
        );
        screenshotFormData.append("file", thumbnailBlob);

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", screenshotData.presignedPostData.url);

          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
              const percent = (event.loaded / event.total) * 100;
              const thumbnailProgress = 90 + percent * 0.1;
              onProgress?.(uploadId, 100, thumbnailProgress);
            }
          };

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve();
            } else {
              reject(
                new Error(`Screenshot upload failed with status ${xhr.status}`)
              );
            }
          };
          xhr.onerror = () => reject(new Error("Screenshot upload failed"));

          xhr.send(screenshotFormData);
        });
      } else {
      }

      onProgress?.(uploadId, 100, 100);
      onComplete?.(uploadId);
      router.refresh();
    } catch (err) {
      console.error("Video upload failed", err);
    } finally {
      setUploading(false);
      setUploadProgress(undefined);
      setProcessingProgress(0);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <>
      <Button
        onClick={handleClick}
        disabled={uploading}
        variant={grey ? "gray" : "primary"}
        size="sm"
      >
        {uploading ? (
          <div className="flex items-center gap-2">
            {status}
            <svg className="w-4 h-4 transform -rotate-90" viewBox="0 0 20 20">
              <circle
                cx="10"
                cy="10"
                r="8"
                stroke="currentColor"
                strokeWidth="3"
                fill="none"
                className={grey ? "text-black/30" : "text-white/30"}
              />
              <circle
                cx="10"
                cy="10"
                r="8"
                stroke="currentColor"
                strokeWidth="3"
                fill="none"
                strokeLinecap="round"
                className={`${
                  grey ? "text-black" : "text-white"
                } transition-all duration-200 ease-out`}
                style={{
                  strokeDasharray: `${circumference} ${circumference}`,
                  strokeDashoffset: `${strokeDashoffset}`,
                }}
              />
            </svg>
          </div>
        ) : (
          "Upload Video"
        )}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept="video/*,.mov,.MOV,.mp4,.MP4,.avi,.AVI,.mkv,.MKV,.webm,.WEBM,.m4v,.M4V"
        onChange={handleChange}
        className="hidden"
      />
      <UpgradeModal
        open={upgradeModalOpen}
        onOpenChange={setUpgradeModalOpen}
      />
    </>
  );
};
