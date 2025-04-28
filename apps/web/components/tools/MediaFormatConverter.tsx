"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@cap/ui";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
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
    command: (input: string, output: string) => string[];
    outputType: string;
    title: (source: string, target: string) => string;
    description: (source: string, target: string) => string;
  }
> = {
  "webm-to-mp4": {
    acceptType: "video/webm",
    command: (input, output) => [
      "-i",
      input,
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
      output,
    ],
    outputType: "video/mp4",
    title: (source, target) =>
      `${source.toUpperCase()} to ${target.toUpperCase()} Converter`,
    description: (source, target) =>
      `Convert ${source.toUpperCase()} videos to ${target.toUpperCase()} format directly in your browser`,
  },
  "mp4-to-webm": {
    acceptType: "video/mp4",
    command: (input, output) => [
      "-i",
      input,
      "-c:v",
      "libvpx",
      "-crf",
      "30",
      "-b:v",
      "0",
      "-c:a",
      "libvorbis",
      output,
    ],
    outputType: "video/webm",
    title: (source, target) =>
      `${source.toUpperCase()} to ${target.toUpperCase()} Converter`,
    description: (source, target) =>
      `Convert ${source.toUpperCase()} videos to ${target.toUpperCase()} format directly in your browser`,
  },
  "mov-to-mp4": {
    acceptType: "video/quicktime",
    command: (input, output) => [
      "-i",
      input,
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "23",
      "-movflags",
      "+faststart",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-y",
      output,
    ],
    outputType: "video/mp4",
    title: (source, target) =>
      `${source.toUpperCase()} to ${target.toUpperCase()} Converter`,
    description: (source, target) =>
      `Convert ${source.toUpperCase()} videos to ${target.toUpperCase()} format directly in your browser`,
  },
  "avi-to-mp4": {
    acceptType: "video/x-msvideo",
    command: (input, output) => [
      "-i",
      input,
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
      output,
    ],
    outputType: "video/mp4",
    title: (source, target) =>
      `${source.toUpperCase()} to ${target.toUpperCase()} Converter`,
    description: (source, target) =>
      `Convert ${source.toUpperCase()} videos to ${target.toUpperCase()} format directly in your browser`,
  },
  "mkv-to-mp4": {
    acceptType: "video/x-matroska",
    command: (input, output) => [
      "-i",
      input,
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
      output,
    ],
    outputType: "video/mp4",
    title: (source, target) =>
      `${source.toUpperCase()} to ${target.toUpperCase()} Converter`,
    description: (source, target) =>
      `Convert ${source.toUpperCase()} videos to ${target.toUpperCase()} format directly in your browser`,
  },

  "mp4-to-mp3": {
    acceptType: "video/mp4",
    command: (input, output) => [
      "-i",
      input,
      "-vn",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-b:a",
      "192k",
      output,
    ],
    outputType: "audio/mp3",
    title: (source, target) =>
      `${source.toUpperCase()} to ${target.toUpperCase()} Converter`,
    description: (source, target) =>
      `Extract audio from ${source.toUpperCase()} videos and save as ${target.toUpperCase()} files`,
  },

  "mp4-to-gif": {
    acceptType: "video/mp4",
    command: (input, output) => [
      "-i",
      input,
      "-vf",
      "fps=10,scale=320:-1:flags=lanczos",
      "-c:v",
      "gif",
      output,
    ],
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
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [currentSourceFormat, setCurrentSourceFormat] = useState(sourceFormat);
  const [currentTargetFormat, setCurrentTargetFormat] = useState(targetFormat);

  const conversionPath = `${currentSourceFormat}-to-${currentTargetFormat}`;
  const config = CONVERSION_CONFIGS[conversionPath];

  const ffmpegRef = useRef<FFmpeg | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    const loadFFmpeg = async () => {
      try {
        const ffmpegInstance = new FFmpeg();
        ffmpegRef.current = ffmpegInstance;

        ffmpegInstance.on("progress", ({ progress }: { progress: number }) => {
          setProgress(Math.round(progress * 100));
        });

        await ffmpegInstance.load();
        setFfmpegLoaded(true);
        trackEvent(`${conversionPath}_tool_loaded`);
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
  }, [conversionPath]);

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
    if (!file || !ffmpegLoaded || !ffmpegRef.current || !config) return;

    setIsConverting(true);
    setError(null);
    setProgress(0);

    trackEvent(`${conversionPath}_conversion_started`, {
      fileSize: file.size,
      fileName: file.name,
    });

    try {
      const ffmpeg = ffmpegRef.current;
      const inputFileName = `input.${currentSourceFormat}`;
      const outputFileName = `output.${currentTargetFormat}`;

      console.log(`Starting conversion: ${conversionPath}`);
      console.log(`Input file: ${file.name}, size: ${file.size} bytes`);

      await ffmpeg.writeFile(inputFileName, await fetchFile(file));
      console.log("File written to FFmpeg virtual filesystem");

      const command = config.command(inputFileName, outputFileName);
      console.log("FFmpeg command:", command);

      await ffmpeg.exec(command);
      console.log("FFmpeg command executed");

      const data = await ffmpeg.readFile(outputFileName);
      console.log(`Output data received, type: ${typeof data}`);

      if (!data) {
        throw new Error(
          "Conversion resulted in an empty file. Please try again."
        );
      }

      const blob = new Blob([data], { type: config.outputType });
      console.log(`Output blob created, size: ${blob.size} bytes`);

      if (blob.size < 1024 && file.size > 10 * 1024) {
        throw new Error(
          "Conversion produced an unusually small file. It may be corrupted."
        );
      }

      const url = URL.createObjectURL(blob);

      setOutputUrl(url);

      trackEvent(`${conversionPath}_conversion_completed`, {
        fileSize: file.size,
        fileName: file.name,
        outputSize: blob.size,
        conversionTime: Date.now(),
      });

      await ffmpeg.deleteFile(inputFileName);
      await ffmpeg.deleteFile(outputFileName);
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

  const handleDownload = () => {
    if (!outputUrl || !file) return;

    const fileExtension = `.${currentSourceFormat}`;
    const newExtension = `.${currentTargetFormat}`;
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
    setFile(null);
    setOutputUrl(null);
    setProgress(0);
    setError(null);

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

      {/* Format Selector */}
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
            disabled={!ffmpegLoaded || isConverting}
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

      {!ffmpegLoaded && !error && (
        <div className="mt-6 text-center text-gray-500">
          <p>Loading conversion engine...</p>
          <div className="mt-2 w-8 h-8 border-4 border-blue-200 border-t-blue-500 rounded-full animate-spin mx-auto"></div>
        </div>
      )}

      <div className="mt-8 pt-6 border-t border-gray-200 text-sm text-gray-500 text-center">
        <p>
          This converter works entirely in your browser. Your files are never
          uploaded to any server.
        </p>
        <p className="mt-1">
          The conversion is performed using FFmpeg, which runs locally on your
          device.
        </p>
      </div>
    </div>
  );
};
