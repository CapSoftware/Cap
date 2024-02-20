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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkSignInStatus = async () => {
      const cookie = getCookie("next-auth.session-token");
      const signedIn = !!cookie;

      if (signedIn !== isSignedIn) {
        setIsSignedIn(signedIn);
      }
      if (loading) {
        setLoading(false);
      }
    };

    checkSignInStatus();
    const interval = setInterval(checkSignInStatus, 1000);

    return () => clearInterval(interval);
  }, [isSignedIn, loading]);

  useEffect(() => {
    if (isSignedIn && !cameraWindowOpen) {
      import("@tauri-apps/api/window").then(
        ({ currentMonitor, WebviewWindow }) => {
          setCameraWindowOpen(true);

          currentMonitor().then((monitor) => {
            const windowWidth = 230;
            const windowHeight = 230;

            if (monitor && monitor.size) {
              const scalingFactor = monitor.scaleFactor;
              const x = 100;
              const y =
                monitor.size.height / scalingFactor - windowHeight - 100;

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
                  y: y,
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
