"use client";

import React, { useState, useEffect } from "react";
import { getCookie } from "cookies-next";
import { SignIn } from "@/components/windows/inner/SignIn";
import { Recorder } from "@/components/windows/inner/Recorder";
import { WindowActions } from "@/components/WindowActions";

export default function CameraPage() {
  const [isSignedIn, setIsSignedIn] = useState(false);

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
