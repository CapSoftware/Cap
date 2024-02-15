"use client";

// import { Recorder } from "@/components/windows/inner/Recorder";
import { SignIn } from "@/components/windows/inner/SignIn";
import { listen } from "@tauri-apps/api/event";
import { appWindow } from "@tauri-apps/api/window";
// import { useAuth } from "@/utils/database/AuthContext";

export const Options = () => {
  // async function setupWindowReShow() {
  //   await listen("tauri://focus", () => {
  //     if (appWindow.isVisible) return;

  //     appWindow
  //       .show()
  //       .catch((err) => console.error("Error showing window:", err));
  //   });
  // }

  // setupWindowReShow();

  return <SignIn />;
};
