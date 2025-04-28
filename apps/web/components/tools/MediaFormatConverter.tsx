"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@cap/ui";
import { trackEvent } from "@/app/utils/analytics";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";

export const SUPPORTED_FORMATS = {
  video: ["mp4", "webm", "mov", "avi", "mkv"],
  audio: ["mp3"],
  image: ["gif"],
};

export const FORMAT_GROUPS = {
  video: ["mp4", "webm", "mov", "avi", "mkv"],
  audio: ["mp3"],
  image: ["gif"],
};

export const CONVERSION_CONFIGS: Record<
  string,
  {
    acceptType: string;
    outputType: string;
    title: (source: string, target: string) => string;
    description: (source: string, target: string) => string;
  }
> = {
  "webm-to-mp4": {
    acceptType: "video/webm",
    outputType: "video/mp4",
    title: (source, target) =>
      `${source.toUpperCase()} to ${target.toUpperCase()} Converter`,
    description: (source, target) =>
      `Convert ${source.toUpperCase()} videos to ${target.toUpperCase()} format directly in your browser`,
  },
  "mp4-to-webm": {
    acceptType: "video/mp4",
    outputType: "video/webm",
    title: (source, target) =>
      `${source.toUpperCase()} to ${target.toUpperCase()} Converter`,
    description: (source, target) =>
      `Convert ${source.toUpperCase()} videos to ${target.toUpperCase()} format directly in your browser`,
  },
  "mov-to-mp4": {
    acceptType: "video/quicktime",
    outputType: "video/mp4",
    title: (source, target) =>
      `${source.toUpperCase()} to ${target.toUpperCase()} Converter`,
    description: (source, target) =>
      `Convert ${source.toUpperCase()} videos to ${target.toUpperCase()} format directly in your browser`,
  },
  "avi-to-mp4": {
    acceptType: "video/x-msvideo",
    outputType: "video/mp4",
    title: (source, target) =>
      `${source.toUpperCase()} to ${target.toUpperCase()} Converter`,
    description: (source, target) =>
      `Convert ${source.toUpperCase()} videos to ${target.toUpperCase()} format directly in your browser`,
  },
  "mkv-to-mp4": {
    acceptType: "video/x-matroska",
    outputType: "video/mp4",
    title: (source, target) =>
      `${source.toUpperCase()} to ${target.toUpperCase()} Converter`,
    description: (source, target) =>
      `Convert ${source.toUpperCase()} videos to ${target.toUpperCase()} format directly in your browser`,
  },
  "mp4-to-mp3": {
    acceptType: "video/mp4",
    outputType: "audio/mp3",
    title: (source, target) =>
      `${source.toUpperCase()} to ${target.toUpperCase()} Converter`,
    description: (source, target) =>
      `Extract audio from ${source.toUpperCase()} videos and save as ${target.toUpperCase()} files`,
  },
  "mp4-to-gif": {
    acceptType: "video/mp4",
    outputType: "image/gif",
    title: (source, target) =>
      `${source.toUpperCase()} to ${target.toUpperCase()} Converter`,
    description: (source, target) =>
      `Convert ${source.toUpperCase()} videos to animated ${target.toUpperCase()} images`,
  },
};

export const parseFormats = (
  conversionPath: string
): { sourceFormat: string; targetFormat: string } => {
  const parts = conversionPath.split("-to-");
  return {
    sourceFormat: parts[0] || "webm",
    targetFormat: parts[1] || "mp4",
  };
};

export const getMimeType = (format: string): string => {
  switch (format) {
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "avi":
      return "video/x-msvideo";
    case "mkv":
      return "video/x-matroska";
    case "mp3":
      return "audio/mp3";
    case "gif":
      return "image/gif";
    default:
      return "";
  }
};

export const getAcceptAttribute = (format: string): string => {
  switch (format) {
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "avi":
      return "video/x-msvideo";
    case "mkv":
      return "video/x-matroska";
    case "mp3":
      return "audio/mp3";
    case "gif":
      return "image/gif";
    default:
      return "";
  }
};

interface MediaFormatConverterProps {
  initialConversionPath: string;
}

export const MediaFormatConverter = ({
  initialConversionPath,
}: MediaFormatConverterProps) => {
  const router = useRouter();
  const pathname = usePathname() || "";

  const { sourceFormat = "webm", targetFormat = "mp4" } = parseFormats(
    initialConversionPath
  );

  const [file, setFile] = useState<File | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mediaEngineLoaded, setMediaEngineLoaded] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [currentSourceFormat, setCurrentSourceFormat] = useState(sourceFormat);
  const [currentTargetFormat, setCurrentTargetFormat] = useState(targetFormat);
  const [supportedFormats, setSupportedFormats] = useState<string[]>([
    "mp4",
    "webm",
  ]);
  const [isSafari, setIsSafari] = useState(false);
  const [isFirefox, setIsFirefox] = useState(false);

  const conversionPath = `${currentSourceFormat}-to-${currentTargetFormat}`;
  const config = CONVERSION_CONFIGS[conversionPath];

  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (
      sourceFormat !== currentSourceFormat ||
      targetFormat !== currentTargetFormat
    ) {
      try {
        const basePath = pathname.split("/").slice(0, -1).join("/");
        const newPath = `${basePath}/${currentSourceFormat}-to-${currentTargetFormat}`;
        router.push(newPath);
      } catch (error) {
        console.error("Error updating URL:", error);
      }
    }
  }, [
    currentSourceFormat,
    currentTargetFormat,
    pathname,
    router,
    sourceFormat,
    targetFormat,
  ]);

  useEffect(() => {
    const checkSupport = async () => {
      if (MediaRecorder.isTypeSupported("video/webm")) {
        setSupportedFormats((prev) => [...prev, "webm"]);
      }

      trackEvent(`${conversionPath}_tool_loaded`);
    };

    checkSupport();
  }, [conversionPath]);

  useEffect(() => {
    const isSafariBrowser = /^((?!chrome|android).)*safari/i.test(
      navigator.userAgent
    );
    setIsSafari(isSafariBrowser);

    const isFirefoxBrowser = navigator.userAgent.indexOf("Firefox") !== -1;
    setIsFirefox(isFirefoxBrowser);
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

    const expectedMimeType = getMimeType(currentSourceFormat);

    let isValidType = false;

    if (currentSourceFormat === "mov") {
      isValidType =
        selectedFile.type === "video/quicktime" ||
        selectedFile.type === "video/mov" ||
        selectedFile.name.toLowerCase().endsWith(".mov");
    } else if (currentSourceFormat === "mkv") {
      isValidType =
        selectedFile.type === "video/x-matroska" ||
        selectedFile.name.toLowerCase().endsWith(".mkv");
    } else if (currentSourceFormat === "avi") {
      isValidType =
        selectedFile.type === "video/x-msvideo" ||
        selectedFile.type === "video/avi" ||
        selectedFile.name.toLowerCase().endsWith(".avi");
    } else {
      isValidType =
        selectedFile.type === expectedMimeType ||
        selectedFile.type.includes(currentSourceFormat) ||
        selectedFile.name.toLowerCase().endsWith(`.${currentSourceFormat}`);
    }

    if (!isValidType) {
      setError(`Please select a ${currentSourceFormat.toUpperCase()} file.`);
      trackEvent(`${conversionPath}_invalid_file_type`, {
        fileType: selectedFile.type,
      });
      return;
    }

    if (selectedFile.size > 500 * 1024 * 1024) {
      setError("File size exceeds 500MB limit.");
      trackEvent(`${conversionPath}_file_too_large`, {
        fileSize: selectedFile.size,
      });
      return;
    }

    setFile(selectedFile);
    trackEvent(`${conversionPath}_file_selected`, {
      fileSize: selectedFile.size,
    });
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

  const convertFile = async () => {
    if (!file || !mediaEngineLoaded || !config) return;

    setIsConverting(true);
    setError(null);
    setProgress(0);

    trackEvent(`${conversionPath}_conversion_started`, {
      fileSize: file.size,
      fileName: file.name,
    });

    try {
      console.log(`Starting conversion: ${conversionPath}`);
      console.log(`Input file: ${file.name}, size: ${file.size} bytes`);

      const fileUrl = URL.createObjectURL(file);

      if (currentTargetFormat === "mp3" && currentSourceFormat === "mp4") {
        await extractAudioFromVideo(fileUrl);
      } else if (
        currentTargetFormat === "gif" &&
        currentSourceFormat === "mp4"
      ) {
        await convertVideoToGif(fileUrl);
      } else {
        await convertVideoFormat(fileUrl);
      }

      URL.revokeObjectURL(fileUrl);
    } catch (err: any) {
      console.error("Detailed conversion error:", err);

      let errorMessage = "Conversion failed: ";
      if (err.message) {
        errorMessage += err.message;
      } else if (typeof err === "string") {
        errorMessage += err;
      } else {
        errorMessage += "Unknown error occurred during conversion";
      }

      setError(errorMessage);

      trackEvent(`${conversionPath}_conversion_failed`, {
        fileSize: file.size,
        fileName: file.name,
        error: err.message || "Unknown error",
      });
    } finally {
      setIsConverting(false);
    }
  };

  const extractAudioFromVideo = async (fileUrl: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const audio = new Audio();
      audio.src = fileUrl;
      audio.muted = false;

      const audioContext = new AudioContext();
      const mediaSource = audioContext.createMediaElementSource(audio);
      const destination = audioContext.createMediaStreamDestination();
      mediaSource.connect(destination);

      const recorder = new MediaRecorder(destination.stream);
      const chunks: BlobPart[] = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: "audio/mp3" });
        const url = URL.createObjectURL(blob);
        setOutputUrl(url);

        trackEvent(`${conversionPath}_conversion_completed`, {
          fileSize: file!.size,
          fileName: file!.name,
          outputSize: blob.size,
        });

        resolve();
      };

      recorder.onerror = (e) => {
        reject(new Error("Error recording audio"));
      };

      audio.oncanplaythrough = () => {
        recorder.start();
        audio.play();

        const interval = setInterval(() => {
          if (audio.duration) {
            const currentProgress = (audio.currentTime / audio.duration) * 100;
            setProgress(Math.min(Math.round(currentProgress), 99));
          }
        }, 500);

        audio.onended = () => {
          clearInterval(interval);
          recorder.stop();
          setProgress(100);
        };
      };

      audio.onerror = () => {
        reject(new Error("Error loading audio from video"));
      };
    });
  };

  const convertVideoToGif = async (fileUrl: string): Promise<void> => {
    setError(
      "Converting video to GIF is currently not fully supported in the browser version. Please try using Google Chrome."
    );
    setProgress(100);
    return Promise.resolve();
  };

  const convertVideoFormat = async (fileUrl: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      videoRef.current = video;
      video.src = fileUrl;
      video.muted = false;

      video.oncanplay = async () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext("2d");

          if (!ctx) {
            throw new Error("Failed to create canvas context");
          }

          const targetMimeType = getMimeType(currentTargetFormat);

          const mimeTypes =
            isFirefox && currentTargetFormat === "mp4"
              ? [
                  "video/webm;codecs=vp8,opus",
                  "video/webm;codecs=vp8",
                  "video/webm",
                ]
              : [
                  targetMimeType,
                  "video/webm;codecs=vp9",
                  "video/webm;codecs=vp8",
                  "video/webm",
                  "video/mp4",
                ];

          let selectedMimeType = "";
          for (const type of mimeTypes) {
            if (MediaRecorder.isTypeSupported(type)) {
              selectedMimeType = type;
              break;
            }
          }

          if (!selectedMimeType) {
            throw new Error(
              "None of the media formats are supported by this browser"
            );
          }

          if (
            isFirefox &&
            currentSourceFormat === "webm" &&
            currentTargetFormat === "mp4"
          ) {
            console.warn(
              "Firefox has limited support for MP4 encoding. Using WebM container instead."
            );
          }

          const stream = canvas.captureStream(30);

          video.muted = true;
          try {
            const audioContext = new AudioContext();
            const source = audioContext.createMediaElementSource(video);
            const destination = audioContext.createMediaStreamDestination();
            source.connect(destination);

            destination.stream.getAudioTracks().forEach((track) => {
              stream.addTrack(track);
            });
          } catch (audioErr) {
            console.warn(
              "Could not add audio track, continuing without audio",
              audioErr
            );
          }

          const recorder = new MediaRecorder(stream, {
            mimeType: selectedMimeType,
          });
          mediaRecorderRef.current = recorder;
          recordedChunksRef.current = [];

          recorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
              recordedChunksRef.current.push(e.data);
            }
          };

          recorder.onstop = () => {
            const chunks = recordedChunksRef.current;
            const outputMimeType = selectedMimeType.split(";")[0];
            const blob = new Blob(chunks, { type: outputMimeType });
            const url = URL.createObjectURL(blob);

            setOutputUrl(url);

            trackEvent(`${conversionPath}_conversion_completed`, {
              fileSize: file!.size,
              fileName: file!.name,
              outputSize: blob.size,
            });

            videoRef.current = null;
            mediaRecorderRef.current = null;
            resolve();
          };

          recorder.start(1000);
          video.play();

          const interval = setInterval(() => {
            if (video.duration) {
              const currentProgress =
                (video.currentTime / video.duration) * 100;
              setProgress(Math.min(Math.round(currentProgress), 99));

              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            }
          }, 30);

          video.onended = () => {
            clearInterval(interval);
            setTimeout(() => {
              recorder.stop();
              setProgress(100);
            }, 500);
          };
        } catch (err) {
          reject(err);
        }
      };

      video.onerror = () => {
        reject(new Error("Error loading video"));
      };
    });
  };

  const handleDownload = () => {
    if (!outputUrl || !file) return;

    let actualExtension = currentTargetFormat;

    if (recordedChunksRef.current.length > 0) {
      const firstChunk = recordedChunksRef.current[0];
      if (firstChunk) {
        const type = firstChunk.type;

        if (type.includes("mp4")) {
          actualExtension = "mp4";
        } else if (type.includes("webm")) {
          actualExtension = "webm";
        } else if (type.includes("mp3")) {
          actualExtension = "mp3";
        } else if (type.includes("gif")) {
          actualExtension = "gif";
        }
      }
    }

    const fileExtension = `.${currentSourceFormat}`;
    const newExtension = `.${actualExtension}`;
    const downloadFileName = file.name.replace(
      new RegExp(`${fileExtension}$`),
      newExtension
    );

    trackEvent(`${conversionPath}_download_clicked`, {
      fileName: downloadFileName,
    });

    const link = document.createElement("a");
    link.href = outputUrl;
    link.download = downloadFileName;
    link.click();
  };

  const resetConverter = () => {
    if (outputUrl) {
      URL.revokeObjectURL(outputUrl);
    }

    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      mediaRecorderRef.current.stop();
    }

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.src = "";
    }

    setFile(null);
    setOutputUrl(null);
    setProgress(0);
    setError(null);
    recordedChunksRef.current = [];

    trackEvent(`${conversionPath}_reset`);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const getValidSourceFormats = () => {
    return Object.keys(CONVERSION_CONFIGS)
      .map((path) => {
        const { sourceFormat } = parseFormats(path);
        return sourceFormat;
      })
      .filter((value, index, self) => self.indexOf(value) === index);
  };

  const getValidTargetFormats = (source: string) => {
    return Object.keys(CONVERSION_CONFIGS)
      .filter((path) => path.startsWith(`${source}-to-`))
      .map((path) => {
        const { targetFormat } = parseFormats(path);
        return targetFormat;
      });
  };

  const validSourceFormats = getValidSourceFormats();
  const validTargetFormats = getValidTargetFormats(currentSourceFormat);

  const handleSourceFormatChange = (newSourceFormat: string) => {
    setCurrentSourceFormat(newSourceFormat);
    const newValidTargets = getValidTargetFormats(newSourceFormat);
    if (
      newValidTargets.length > 0 &&
      !newValidTargets.includes(currentTargetFormat)
    ) {
      if (newValidTargets[0]) {
        setCurrentTargetFormat(newValidTargets[0]);
      }
    }
    resetConverter();
  };

  const handleTargetFormatChange = (newTargetFormat: string) => {
    setCurrentTargetFormat(newTargetFormat);
    resetConverter();
  };

  if (!config) {
    return (
      <div className="p-6 bg-red-50 border border-red-200 rounded-lg text-red-600">
        <p>Unsupported conversion: {conversionPath}</p>
        <Link
          href="/tools/convert"
          className="mt-4 inline-flex items-center text-blue-600 hover:text-blue-800"
        >
          ← Back to Conversion Tools
        </Link>
      </div>
    );
  }

  return (
    <div className="w-full">
      <h2 className="text-2xl font-semibold text-center mb-6">
        {config.title(currentSourceFormat, currentTargetFormat)}
      </h2>

      <div className="w-full mb-6">
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-2">
          <div className="w-full sm:w-auto flex flex-col sm:flex-row items-center">
            <span className="w-full sm:w-auto text-center sm:text-left mb-2 sm:mb-0 sm:mr-2 text-gray-700 font-medium">
              From:
            </span>
            <div className="flex flex-wrap justify-center gap-2 w-full">
              {validSourceFormats.map((format) => (
                <Link
                  key={format}
                  href={`/tools/convert/${format}-to-${
                    getValidTargetFormats(format).includes(currentTargetFormat)
                      ? currentTargetFormat
                      : getValidTargetFormats(format)[0]
                  }`}
                  onClick={(e) => {
                    e.preventDefault();
                    handleSourceFormatChange(format);
                  }}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium text-center min-w-[60px] ${
                    currentSourceFormat === format
                      ? "bg-blue-600 text-white"
                      : "bg-gray-200 text-gray-800 hover:bg-gray-300"
                  }`}
                  aria-label={`Convert from ${format.toUpperCase()} format`}
                >
                  {format.toUpperCase()}
                </Link>
              ))}
            </div>
          </div>

          <span className="hidden sm:block mx-2 text-gray-400">→</span>
          <div className="w-full sm:hidden flex justify-center my-2">
            <span className="text-gray-400 text-xl">↓</span>
          </div>

          <div className="w-full sm:w-auto flex flex-col sm:flex-row items-center">
            <span className="w-full sm:w-auto text-center sm:text-left mb-2 sm:mb-0 sm:mr-2 text-gray-700 font-medium">
              To:
            </span>
            <div className="flex flex-wrap justify-center gap-2 w-full">
              {validTargetFormats.map((format) => (
                <Link
                  key={format}
                  href={`/tools/convert/${currentSourceFormat}-to-${format}`}
                  onClick={(e) => {
                    e.preventDefault();
                    handleTargetFormatChange(format);
                  }}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium text-center min-w-[60px] ${
                    currentTargetFormat === format
                      ? "bg-blue-600 text-white"
                      : "bg-gray-200 text-gray-800 hover:bg-gray-300"
                  }`}
                  aria-label={`Convert to ${format.toUpperCase()} format`}
                >
                  {format.toUpperCase()}
                </Link>
              ))}
            </div>
          </div>
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
          accept={getAcceptAttribute(currentSourceFormat)}
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
                Drag and drop your {currentSourceFormat.toUpperCase()} file here
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
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-600">
          {error}
        </div>
      )}

      {isConverting && (
        <div className="mb-6">
          <p className="text-center text-gray-700 mb-2">
            Converting... {progress}%
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
            Conversion complete!
          </p>
          {config.outputType.startsWith("video/") && (
            <video
              src={outputUrl}
              controls
              className="w-full rounded-lg mb-4 bg-black"
              style={{ maxHeight: "300px" }}
            ></video>
          )}
          {config.outputType.startsWith("audio/") && (
            <audio
              src={outputUrl}
              controls
              className="w-full rounded-lg mb-4"
            ></audio>
          )}
          {config.outputType.startsWith("image/") && (
            <img
              src={outputUrl}
              alt="Converted GIF"
              className="max-w-full rounded-lg mb-4 mx-auto"
              style={{ maxHeight: "300px" }}
            />
          )}
          <div className="flex flex-col sm:flex-row space-y-3 sm:space-y-0 sm:space-x-3">
            <Button
              variant="primary"
              onClick={handleDownload}
              className="w-full"
            >
              Download {currentTargetFormat.toUpperCase()}
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-col sm:flex-row space-y-3 sm:space-y-0 sm:space-x-3">
        {file && !isConverting && !outputUrl && (
          <Button
            variant="primary"
            onClick={convertFile}
            disabled={!mediaEngineLoaded || isConverting}
            className="w-full"
          >
            Convert to {currentTargetFormat.toUpperCase()}
          </Button>
        )}

        {(file || outputUrl) && (
          <Button
            variant="white"
            onClick={resetConverter}
            disabled={isConverting}
            className="w-full"
          >
            {outputUrl ? "Convert Another File" : "Reset"}
          </Button>
        )}
      </div>

      <div className="mt-8 pt-6 border-t border-gray-200 text-sm text-gray-500 text-center">
        <p>
          This converter works entirely in your browser. Your files are never
          uploaded to any server.
        </p>
        <p className="mt-1">
          Powered by modern browser APIs like MediaRecorder and WebAudio for
          fast and efficient conversion.
        </p>
        {isSafari && (
          <div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded-md text-yellow-700">
            <p>
              <strong>Safari Compatibility Notice:</strong> Safari has limited
              support for some media conversion features. For best results,
              consider using Chrome or Firefox.
            </p>
          </div>
        )}
        {isFirefox &&
          currentSourceFormat === "webm" &&
          currentTargetFormat === "mp4" && (
            <div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded-md text-yellow-700">
              <p>
                <strong>Firefox Compatibility Notice:</strong> Firefox doesn't
                fully support converting WebM to MP4. The file will be encoded
                using WebM container format. For best results, try using Chrome.
              </p>
            </div>
          )}
      </div>
    </div>
  );
};
