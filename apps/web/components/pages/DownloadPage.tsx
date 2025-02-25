"use client";

import { Button, LogoBadge } from "@cap/ui";
import { useEffect, useState } from "react";
import {
  detectPlatform,
  getDownloadButtonText,
  getDownloadUrl,
  getPlatformIcon,
  getVersionText,
  PlatformIcons,
} from "@/utils/platform";

export const DownloadPage = () => {
  const [loading, setLoading] = useState(true);
  const [platform, setPlatform] = useState<string | null>(null);
  const [isIntel, setIsIntel] = useState(false);
  const [showDebug, setShowDebug] = useState(true);

  useEffect(() => {
    const detectUserPlatform = async () => {
      try {
        const { platform, isIntel } = await detectPlatform();
        setPlatform(platform);
        setIsIntel(isIntel);
      } catch (error) {
        console.error("Error detecting platform:", error);
      } finally {
        setLoading(false);
      }
    };

    detectUserPlatform();
  }, []);

  const simulatePlatform = (newPlatform: string, newIsIntel: boolean) => {
    setPlatform(newPlatform);
    setIsIntel(newIsIntel);
  };

  return (
    <div className="pt-32 pb-16 wrapper wrapper-sm md:py-32">
      <div className="space-y-4 text-center">
        {/* Debug toggle button in top-right corner */}
        <button
          onClick={() => setShowDebug(!showDebug)}
          className="absolute top-4 right-4 text-xs text-gray-400 hover:text-gray-300 bg-gray-800 px-2 py-1 rounded"
        >
          {showDebug ? "Hide Debug" : "Debug"}
        </button>

        {/* Debug panel */}
        {showDebug && (
          <div className="fixed top-10 right-4 bg-gray-800 p-3 rounded shadow-lg z-50 text-left">
            <div className="text-xs text-gray-300 mb-2">Platform Simulator</div>
            <div className="space-y-2">
              <button
                onClick={() => simulatePlatform("windows", false)}
                className={`text-xs px-2 py-1 rounded w-full text-left ${
                  platform === "windows"
                    ? "bg-blue-600"
                    : "bg-gray-700 hover:bg-gray-600"
                }`}
              >
                Windows (Beta)
              </button>
              <button
                onClick={() => simulatePlatform("macos", true)}
                className={`text-xs px-2 py-1 rounded w-full text-left ${
                  platform === "macos" && isIntel
                    ? "bg-blue-600"
                    : "bg-gray-700 hover:bg-gray-600"
                }`}
              >
                macOS (Intel)
              </button>
              <button
                onClick={() => simulatePlatform("macos", false)}
                className={`text-xs px-2 py-1 rounded w-full text-left ${
                  platform === "macos" && !isIntel
                    ? "bg-blue-600"
                    : "bg-gray-700 hover:bg-gray-600"
                }`}
              >
                macOS (Apple Silicon)
              </button>
              <div className="text-xs text-gray-400 mt-2">
                Current: {platform}{" "}
                {platform === "macos" &&
                  (isIntel ? "(Intel)" : "(Apple Silicon)")}
              </div>
            </div>
          </div>
        )}

        <h1 className="text-2xl fade-in-down animate-delay-1 md:text-4xl">
          Download Cap
        </h1>
        <p className="px-4 text-sm fade-in-down animate-delay-2 md:text-base md:px-0">
          The quickest way to share your screen. Pin to your dock and record in
          seconds.
        </p>
        <div className="flex flex-col justify-center items-center space-y-4 fade-in-up animate-delay-2">
          <div className="flex flex-col items-center space-y-4">
            <Button
              variant="radialblue"
              size="lg"
              href={getDownloadUrl(platform, isIntel)}
              className="font-medium flex items-center justify-center text-white py-6"
            >
              {!loading && getPlatformIcon(platform)}
              {getDownloadButtonText(platform, loading, isIntel)}
            </Button>

            <div className="text-sm text-gray-400">
              {getVersionText(platform)}
            </div>

            {/* Windows SmartScreen video and instructions */}
            {platform === "windows" && (
              <div className="mt-4 max-w-md">
                <video
                  src="/windows-smartscreen.mp4"
                  autoPlay
                  loop
                  muted
                  playsInline
                  className="w-full rounded-md shadow-md mx-auto"
                  style={{ maxWidth: "300px" }}
                />
                <p className="text-sm text-gray-400 mt-2">
                  Whilst Cap for Windows is in early beta, after downloading and
                  running the app, follow the steps above to whitelist Cap on
                  your PC.
                </p>
              </div>
            )}
          </div>
        </div>

        <PlatformIcons />

        <div className="mt-6 fade-in-up animate-delay-2">
          <h3 className="text-sm font-medium mb-2 text-gray-400">
            Other download options:
          </h3>
          <div className="flex flex-col md:flex-row justify-center items-center gap-3">
            {platform !== "windows" && (
              <a
                href="/download/windows"
                className="text-sm text-gray-400 hover:underline transition-all"
              >
                Windows (Beta)
              </a>
            )}
            {platform === "macos" && isIntel && (
              <a
                href="/download/apple-silicon"
                className="text-sm text-gray-400 hover:underline transition-all"
              >
                Apple Silicon
              </a>
            )}
            {platform === "macos" && !isIntel && (
              <a
                href="/download/apple-intel"
                className="text-sm text-gray-400 hover:underline transition-all"
              >
                Apple Intel
              </a>
            )}
            {platform !== "macos" && (
              <>
                <a
                  href="/download/apple-silicon"
                  className="text-sm text-gray-400 hover:underline transition-all"
                >
                  Apple Silicon
                </a>
                <a
                  href="/download/apple-intel"
                  className="text-sm text-gray-400 hover:underline transition-all"
                >
                  Apple Intel
                </a>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
