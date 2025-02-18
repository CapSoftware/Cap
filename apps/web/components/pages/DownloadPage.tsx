"use client";

import { Button, LogoBadge } from "@cap/ui";
import { useState } from "react";

export const DownloadPage = () => {
  const [loading, setLoading] = useState(false);
  const [showOtherOptions, setShowOtherOptions] = useState(false);

  const releaseFetch = async () => {
    setLoading(true);
    const response = await fetch("/api/releases/macos");
    const data = await response.json();

    if (data.url) {
      window.location.href = data.url;
    }

    setLoading(false);
  };

  return (
    <div className="pt-32 pb-16 wrapper wrapper-sm md:py-52">
      <div className="space-y-4 text-center">
        <h1 className="text-2xl fade-in-down animate-delay-1 md:text-4xl">
          Download Cap
        </h1>
        <p className="px-4 text-sm fade-in-down animate-delay-2 md:text-base md:px-0">
          The quickest way to share your screen. Pin to your dock and record in
          seconds.
        </p>
        <div className="flex flex-col justify-center items-center space-y-2 md:flex-row md:space-y-0 md:space-x-2 fade-in-up animate-delay-2">
          <Button
            variant="radialblue"
            spinner={loading}
            size="lg"
            href="https://solitary-art-7d28.brendonovich.workers.dev/desktop/latest/platform/dmg-aarch64"
            className="w-full font-medium md:w-auto"
          >
            Download for Apple Silicon
          </Button>
          {showOtherOptions && (
            <Button
              variant="radialblue"
              size="lg"
              href="https://solitary-art-7d28.brendonovich.workers.dev/desktop/latest/platform/dmg-x86_64"
              className="w-full font-medium md:w-auto"
            >
              Download for Mac Intel
            </Button>
          )}
        </div>
        <div className="fade-in-up animate-delay-2">
          <p className="text-xs">macOS 13+ or later recommended.</p>
        </div>
        {!showOtherOptions && (
          <button
            onClick={() => setShowOtherOptions(true)}
            className="mt-2 text-sm text-gray-400 underline fade-in-up animate-delay-2"
          >
            See other options
          </button>
        )}
      </div>
    </div>
  );
};
