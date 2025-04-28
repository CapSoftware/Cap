"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@cap/ui";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import { trackEvent } from "@/app/utils/analytics";

const SPEED_OPTIONS = [
  { value: 0.25, label: "0.25x (Very Slow)" },
  { value: 0.5, label: "0.5x (Slow)" },
  { value: 0.75, label: "0.75x (Slightly Slow)" },
  { value: 1.25, label: "1.25x (Slightly Fast)" },
  { value: 1.5, label: "1.5x (Fast)" },
  { value: 2, label: "2x (Very Fast)" },
  { value: 3, label: "3x (Ultra Fast)" },
];

const SUPPORTED_VIDEO_FORMATS = ["mp4", "webm", "mov", "avi", "mkv"];

export const SpeedController = () => {
  const [file, setFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedSpeed, setSelectedSpeed] = useState<number>(1.5);
  const [videoInfo, setVideoInfo] = useState<{
    duration: number;
    dimensions: string;
  } | null>(null);

  const ffmpegRef = useRef<FFmpeg | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const loadFFmpeg = async () => {
      try {
        const ffmpegInstance = new FFmpeg();
        ffmpegRef.current = ffmpegInstance;

        ffmpegInstance.on("progress", ({ progress }: { progress: number }) => {
          setProgress(Math.round(progress * 100));
        });

        await ffmpegInstance.load();
        setFfmpegLoaded(true);
        trackEvent("speed_controller_loaded");
      } catch (err) {
        setError("Failed to load FFmpeg. Please try again later.");
        console.error("FFmpeg loading error:", err);
      }
    };

    loadFFmpeg();

    return () => {
      if (outputUrl) {
        URL.revokeObjectURL(outputUrl);
      }
    };
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      validateAndSetFile(selectedFile);
    }
  };

  const validateAndSetFile = (selectedFile: File) => {
    setError(null);
    setOutputUrl(null);
    setVideoInfo(null);

    const isVideoFile =
      selectedFile.type.startsWith("video/") ||
      SUPPORTED_VIDEO_FORMATS.some((format) =>
        selectedFile.name.toLowerCase().endsWith(`.${format}`)
      );

    if (!isVideoFile) {
      setError("Please select a valid video file.");
      trackEvent("speed_controller_invalid_file_type", {
        fileType: selectedFile.type,
      });
      return;
    }

    if (selectedFile.size > 500 * 1024 * 1024) {
      setError("File size exceeds 500MB limit.");
      trackEvent("speed_controller_file_too_large", {
        fileSize: selectedFile.size,
      });
      return;
    }

    setFile(selectedFile);
    trackEvent("speed_controller_file_selected", {
      fileSize: selectedFile.size,
      fileType: selectedFile.type,
    });

    const videoElement = document.createElement("video");
    videoElement.preload = "metadata";

    videoElement.onloadedmetadata = () => {
      URL.revokeObjectURL(videoElement.src);
      const duration = videoElement.duration;
      const dimensions = `${videoElement.videoWidth}x${videoElement.videoHeight}`;
      setVideoInfo({ duration, dimensions });
    };

    videoElement.src = URL.createObjectURL(selectedFile);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) {
      validateAndSetFile(droppedFile);
    }
  };

  const processVideo = async () => {
    if (!file || !ffmpegLoaded || !ffmpegRef.current) return;

    setIsProcessing(true);
    setError(null);
    setProgress(0);

    const action = selectedSpeed < 1 ? "slowing_down" : "speeding_up";
    trackEvent(`speed_controller_${action}_started`, {
      fileSize: file.size,
      fileName: file.name,
      speedFactor: selectedSpeed,
    });

    try {
      const ffmpeg = ffmpegRef.current;
      const inputFileName = `input_${Date.now()}.mp4`;
      const outputFileName = `output_${Date.now()}.mp4`;

      console.log(`Starting video speed adjustment: ${selectedSpeed}x`);
      console.log(`Input file: ${file.name}, size: ${file.size} bytes`);

      await ffmpeg.writeFile(inputFileName, await fetchFile(file));
      console.log("File written to FFmpeg virtual filesystem");

      let atempoFilter = "";
      let speedFactor = selectedSpeed;

      if (selectedSpeed < 0.5) {
        atempoFilter = `atempo=0.5,atempo=${selectedSpeed / 0.5}`;
      } else if (selectedSpeed > 2) {
        const iterations = Math.ceil(Math.log2(selectedSpeed));
        const values = [];
        let remaining = selectedSpeed;

        for (let i = 0; i < iterations; i++) {
          if (remaining > 2) {
            values.push(2);
            remaining /= 2;
          } else {
            values.push(remaining);
            break;
          }
        }

        atempoFilter = values.map((v) => `atempo=${v}`).join(",");
      } else {
        atempoFilter = `atempo=${speedFactor}`;
      }

      const command = [
        "-i",
        inputFileName,
        "-filter_complex",
        `[0:v]setpts=${1 / selectedSpeed}*PTS[v];[0:a]${atempoFilter}[a]`,
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        outputFileName,
      ];

      console.log("FFmpeg command:", command);

      await ffmpeg.exec(command);
      console.log("FFmpeg command executed");

      const data = await ffmpeg.readFile(outputFileName);
      console.log(`Output data received, type: ${typeof data}`);

      if (!data) {
        throw new Error(
          "Processing resulted in an empty file. Please try again."
        );
      }

      const blob = new Blob([data], { type: "video/mp4" });
      console.log(`Output blob created, size: ${blob.size} bytes`);

      if (blob.size < 1024 && file.size > 10 * 1024) {
        throw new Error(
          "Processing produced an unusually small file. It may be corrupted."
        );
      }

      const url = URL.createObjectURL(blob);

      setOutputUrl(url);

      trackEvent(`speed_controller_${action}_completed`, {
        fileSize: file.size,
        fileName: file.name,
        outputSize: blob.size,
        speedFactor: selectedSpeed,
      });

      await ffmpeg.deleteFile(inputFileName);
      await ffmpeg.deleteFile(outputFileName);
    } catch (err: any) {
      console.error("Detailed processing error:", err);

      let errorMessage = "Processing failed: ";
      if (err.message) {
        errorMessage += err.message;
      } else if (typeof err === "string") {
        errorMessage += err;
      } else {
        errorMessage += "Unknown error occurred during processing";
      }

      setError(errorMessage);

      trackEvent(`speed_controller_${action}_failed`, {
        fileSize: file.size,
        fileName: file.name,
        error: err.message || "Unknown error",
        speedFactor: selectedSpeed,
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDownload = () => {
    if (!outputUrl || !file) return;

    const dotIndex = file.name.lastIndexOf(".");
    const baseName =
      dotIndex !== -1 ? file.name.substring(0, dotIndex) : file.name;
    const downloadFileName = `${baseName}_${selectedSpeed}x.mp4`;

    trackEvent(`speed_controller_download_clicked`, {
      fileName: downloadFileName,
      speedFactor: selectedSpeed,
    });

    const link = document.createElement("a");
    link.href = outputUrl;
    link.download = downloadFileName;
    link.click();
  };

  const resetController = () => {
    if (outputUrl) {
      URL.revokeObjectURL(outputUrl);
    }
    setFile(null);
    setOutputUrl(null);
    setProgress(0);
    setError(null);
    setVideoInfo(null);

    trackEvent(`speed_controller_reset`);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const formatDuration = (seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
  };

  const getEstimatedOutputDuration = () => {
    if (!videoInfo) return null;
    const estimatedDuration = videoInfo.duration / selectedSpeed;
    return formatDuration(estimatedDuration);
  };

  return (
    <div className="w-full">
      <h2 className="text-2xl font-semibold text-center mb-6">
        {selectedSpeed < 1 ? "Slow Down" : "Speed Up"} Your Video
      </h2>

      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Select Speed
        </label>
        <div className="flex flex-wrap gap-2 justify-center">
          {SPEED_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => setSelectedSpeed(option.value)}
              className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                selectedSpeed === option.value
                  ? "bg-blue-600 text-white"
                  : "bg-gray-200 text-gray-800 hover:bg-gray-300"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div
        className={`border-2 border-dashed rounded-lg p-8 mb-6 flex flex-col items-center justify-center cursor-pointer transition-colors ${
          isDragging
            ? "border-blue-500 bg-blue-50"
            : "border-gray-300 hover:border-blue-400"
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        style={{ minHeight: "200px" }}
      >
        <input
          type="file"
          accept="video/*"
          className="hidden"
          onChange={handleFileChange}
          ref={fileInputRef}
        />

        <div className="text-center">
          {!file ? (
            <>
              <svg
                className="mx-auto h-12 w-12 text-gray-400 mb-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                />
              </svg>
              <p className="text-lg font-medium text-gray-700">
                Drag and drop your video file here
              </p>
              <p className="text-sm text-gray-500 mt-1">
                or click to browse (max 500MB)
              </p>
            </>
          ) : (
            <>
              <svg
                className="mx-auto h-12 w-12 text-green-500 mb-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              <p className="text-lg font-medium text-gray-700">{file.name}</p>
              <p className="text-sm text-gray-500 mt-1">
                {(file.size / (1024 * 1024)).toFixed(2)} MB
              </p>
              {videoInfo && (
                <div className="mt-3 text-sm text-gray-600">
                  <p>Duration: {formatDuration(videoInfo.duration)}</p>
                  <p>Resolution: {videoInfo.dimensions}</p>
                  <p className="mt-2 font-medium">
                    Estimated output duration: {getEstimatedOutputDuration()}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-600">
          {error}
        </div>
      )}

      {isProcessing && (
        <div className="mb-6">
          <p className="text-center text-gray-700 mb-2">
            Processing... {progress}%
          </p>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all"
              style={{ width: `${progress}%` }}
            ></div>
          </div>
        </div>
      )}

      {outputUrl && (
        <div className="mb-6 p-5 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-green-700 font-medium mb-3">
            Video {selectedSpeed < 1 ? "slowed down" : "sped up"} successfully!
          </p>
          <video
            ref={videoPreviewRef}
            src={outputUrl}
            controls
            className="w-full rounded-lg mb-4 bg-black"
            style={{ maxHeight: "400px" }}
          ></video>
          <div className="flex flex-col sm:flex-row space-y-3 sm:space-y-0 sm:space-x-3">
            <Button
              variant="primary"
              onClick={handleDownload}
              className="w-full"
            >
              Download {selectedSpeed}x Video
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-col sm:flex-row space-y-3 sm:space-y-0 sm:space-x-3">
        {file && !isProcessing && !outputUrl && (
          <Button
            variant="primary"
            onClick={processVideo}
            disabled={!ffmpegLoaded || isProcessing}
            className="w-full"
          >
            {selectedSpeed < 1 ? "Slow Down" : "Speed Up"} Video (
            {selectedSpeed}x)
          </Button>
        )}

        {(file || outputUrl) && (
          <Button
            variant="white"
            onClick={resetController}
            disabled={isProcessing}
            className="w-full"
          >
            {outputUrl ? "Process Another Video" : "Reset"}
          </Button>
        )}
      </div>

      {!ffmpegLoaded && !error && (
        <div className="mt-6 text-center text-gray-500">
          <p>Loading processing engine...</p>
          <div className="mt-2 w-8 h-8 border-4 border-blue-200 border-t-blue-500 rounded-full animate-spin mx-auto"></div>
        </div>
      )}

      <div className="mt-8 pt-6 border-t border-gray-200 text-sm text-gray-500 text-center">
        <p>
          This tool works entirely in your browser. Your videos are never
          uploaded to any server.
        </p>
        <p className="mt-1">
          Video processing is performed using FFmpeg, which runs locally on your
          device.
        </p>
      </div>
    </div>
  );
};
