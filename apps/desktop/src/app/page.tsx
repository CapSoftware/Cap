"use client";

import React, { useState, useEffect } from "react";
import { getCookie } from "cookies-next";
import { SignIn } from "@/components/windows/inner/SignIn";
import { Recorder } from "@/components/windows/inner/Recorder";
import { WindowActions } from "@/components/WindowActions";
import { WebviewWindow, currentMonitor } from "@tauri-apps/api/window";

export default function CameraPage() {
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [cameraWindowOpen, setCameraWindowOpen] = useState(false);

  useEffect(() => {
    const cookie = getCookie("next-auth.session-token");
    setIsSignedIn(!!cookie);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      const cookie = getCookie("next-auth.session-token");
      setIsSignedIn(!!cookie);
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (isSignedIn) {
      setCameraWindowOpen(true);
      if (cameraWindowOpen) {
        return;
      }

      currentMonitor().then((monitor) => {
        const paddingRatio = 0.125;
        const windowWidth = 250;
        const windowHeight = 250;

        if (monitor && monitor.size) {
          const monitorWidth = monitor.size.width;
          const monitorHeight = monitor.size.height;

          // calculate padding in pixels
          const horizontalPadding = monitorWidth * paddingRatio;
          const verticalPadding = monitorHeight * paddingRatio;

          // calculate x and y
          const x = 100;
          const y = monitorHeight - windowHeight - verticalPadding - 100;

          console.log("Opening camera window at", x, y);
          console.log("Monitor size", monitorWidth, monitorHeight);
          console.log("Window size", windowWidth, windowHeight);
          console.log("Padding", horizontalPadding, verticalPadding);
          console.log("Padding ratio", paddingRatio);

          const existingCameraWindow = WebviewWindow.getByLabel("camera");

          if (existingCameraWindow) {
            console.log("Camera window already open.");
            existingCameraWindow.close();
          }

          const cameraWindow = new WebviewWindow("camera", {
            url: "/camera",
            title: "Cap Camera",
            width: windowWidth,
            height: windowHeight,
            x: x / 2,
            y: y / 2,
            maximized: false,
            resizable: false,
            fullscreen: false,
            transparent: true,
            decorations: false,
            alwaysOnTop: true,
            center: false,
          });

          console.log("Camera window opened:", cameraWindow);
        }
      });
    }
  }, [isSignedIn, cameraWindowOpen]);

  return (
    <div
      id="app"
      data-tauri-drag-region
      style={{ borderRadius: "16px" }}
      className="pt-4"
    >
      <WindowActions />
      {isSignedIn ? <Recorder /> : <SignIn />}
    </div>
  );
}
