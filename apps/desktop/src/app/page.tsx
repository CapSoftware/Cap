"use client";

import React, { useState, useEffect } from "react";
import { getCookie } from "cookies-next";
import { SignIn } from "@/components/windows/inner/SignIn";
import { Recorder } from "@/components/windows/inner/Recorder";
import { WindowActions } from "@/components/WindowActions";
import { LogoSpinner } from "@cap/ui";

export default function CameraPage() {
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [cameraWindowOpen, setCameraWindowOpen] = useState(false);
  const [loading, setLoading] = useState(true); // Added loading state

  useEffect(() => {
    const checkSignInStatus = async () => {
      const cookie = getCookie("next-auth.session-token");
      setIsSignedIn(!!cookie);
      setLoading(false); // Set loading to false after checking sign-in status
    };

    checkSignInStatus();

    const interval = setInterval(checkSignInStatus, 1000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (isSignedIn && !cameraWindowOpen) {
      import("@tauri-apps/api/window").then(
        ({ currentMonitor, WebviewWindow }) => {
          setCameraWindowOpen(true);

          currentMonitor().then((monitor) => {
            const windowWidth = 250;
            const windowHeight = 250;

            if (monitor && monitor.size) {
              const x = 100;
              const y = monitor.size.height * 0.66;
              const scalingFactor = monitor.scaleFactor;

              console.log("x", x);
              console.log("y", y);
              console.log("scalingFactor", scalingFactor);
              console.log("monitor", monitor);
              console.log("monitor.size", monitor.size);
              console.log("monitor.size.height", monitor.size.height);
              console.log("windowHeight", windowHeight);
              console.log("windowWidth", windowWidth);

              const existingCameraWindow = WebviewWindow.getByLabel("camera");
              if (existingCameraWindow) {
                console.log("Camera window already open.");
                existingCameraWindow.close();
              } else {
                new WebviewWindow("camera", {
                  url: "/camera",
                  title: "Cap Camera",
                  width: windowWidth,
                  height: windowHeight,
                  x: x / scalingFactor,
                  y: y / scalingFactor,
                  maximized: false,
                  resizable: false,
                  fullscreen: false,
                  transparent: true,
                  decorations: false,
                  alwaysOnTop: true,
                  center: false,
                });
              }
            }
          });
        }
      );
    }
  }, [isSignedIn, cameraWindowOpen]);

  // Show loading screen, a spinner or similar, to prevent flash
  if (loading) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <LogoSpinner className="w-10 h-auto animate-spin" />
      </div>
    );
  }

  return (
    <div id="app" data-tauri-drag-region style={{ borderRadius: "16px" }}>
      <WindowActions />
      {isSignedIn ? <Recorder /> : <SignIn />}
    </div>
  );
}
