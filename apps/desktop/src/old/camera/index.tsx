"use client";

import { Camera } from "@/components/windows/Camera";

export default function CameraPage() {
  return (
    <div id="app" data-tauri-drag-region style={{ borderRadius: "50%" }}>
      <Camera />
    </div>
  );
}
