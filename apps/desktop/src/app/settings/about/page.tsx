"use client";

import { getVersion } from "@tauri-apps/api/app";
import { useState, useEffect } from "react";

export default function About() {
  const [appVersion, setAppVersion] = useState(null);

  useEffect(() => {
    getVersion()
      .then((version) => setAppVersion(version))
      .catch((error) => console.error(error));
  }, []);

  return (
    <div className="min-h-screen p-4">
      <div className="max-w-xl mx-auto p-4 bg-white rounded-lg shadow-sm mt-4">
        <h1 className="text-xl font-semibold mb-2">About the App</h1>
        <p className="text-gray-700">
          {appVersion ? (
            <span className="text-green-600">App Version: {appVersion}</span>
          ) : (
            <span className="text-red-600">Loading App Version...</span>
          )}
        </p>
      </div>
    </div>
  );
}