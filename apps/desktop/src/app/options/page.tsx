"use client";

import { SignIn } from "@/components/windows/inner/SignIn";
import { Recorder } from "@/components/windows/inner/Recorder";
import { WindowActions } from "@/components/WindowActions";

export default function CameraPage() {
  return (
    <div
      id="app"
      data-tauri-drag-region
      style={{ borderRadius: "16px" }}
      className="pt-4"
    >
      <WindowActions />
      <SignIn />
    </div>
  );
}
