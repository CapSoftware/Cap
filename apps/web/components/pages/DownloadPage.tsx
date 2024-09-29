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
    <div className="wrapper wrapper-sm py-32">
      <div className="text-center space-y-4">
        <h1 className="fade-in-down animate-delay-1">Download Cap</h1>
        <p className="fade-in-down animate-delay-2">
          The quickest way to share your screen. Pin to your dock and record in
          seconds.
        </p>
        <div className="flex items-center justify-center space-x-2 fade-in-up animate-delay-2">
          <Button
            spinner={loading}
            size="lg"
            href="https://cdn.crabnebula.app/download/cap/cap/latest/platform/dmg-aarch64"
            className=" mx-auto"
          >
            Download for Apple Silicon
          </Button>
          {showOtherOptions && (
            <Button
              size="lg"
              href="https://cdn.crabnebula.app/download/cap/cap/latest/platform/dmg-x86_64"
              className=" mx-auto"
            >
              Download for Intel
            </Button>
          )}
        </div>
        {!showOtherOptions && (
          <button
            onClick={() => setShowOtherOptions(true)}
            className="mt-2 underline text-sm text-gray-400 fade-in-up animate-delay-2"
          >
            See other options
          </button>
        )}
      </div>
    </div>
  );
};
