"use client";

import { Camera } from "@/components/windows/Camera";

export const dynamic = "force-static";

export default function CameraPage() {
  return (
    <div
      id="app"
      style={{
        border: "none",
        background: "none",
        outline: "none",
        boxShadow: "none",
      }}
    >
      <Camera />
    </div>
  );
}
