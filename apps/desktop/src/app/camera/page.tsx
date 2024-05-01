"use client";

import { Camera } from "@/components/windows/Camera";

export const dynamic = "force-static";

export default function CameraPage() {
  return (
    <div
      id="app"
      data-tauri-drag-region
      style={{
        borderRadius: "50%",
        background: "none !important",
        outline: "none",
        boxShadow: "none",
      }}
    >
      <Camera />
    </div>
  );
}
