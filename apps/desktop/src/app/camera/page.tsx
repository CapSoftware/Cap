"use client";

import { Camera } from "@/components/windows/Camera";
import { setWindowPosition } from "@/utils/helpers";

export default function CameraPage() {
  setWindowPosition("bottom_right");
  return (
    <div id="app" data-tauri-drag-region style={{ borderRadius: "50%" }}>
      <Camera />
    </div>
  );
}
