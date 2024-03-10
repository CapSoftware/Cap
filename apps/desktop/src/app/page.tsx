"use client";

import React, { useState, useEffect } from "react";
import { SignIn } from "@/components/windows/inner/SignIn";
import { Recorder } from "@/components/windows/inner/Recorder";
import { WindowActions } from "@/components/WindowActions";
import { Permissions } from "@/components/windows/Permissions";
import { LogoSpinner } from "@cap/ui";
import { getPermissions, savePermissions } from "@/utils/helpers";
import { initializeCameraWindow } from "@/utils/recording/utils";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/tauri";
import toast from "react-hot-toast";

export default function CameraPage() {
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [cameraWindowOpen, setCameraWindowOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [permissions, setPermissions] = useState(getPermissions());

  useEffect(() => {
    const checkVersion = async () => {
      const storedVersion = localStorage.getItem("cap_test_build_version");
      const appVersion = await getVersion();

      if (!storedVersion) {
        console.log("No version stored");
        localStorage.setItem("cap_test_build_version", appVersion);

        if (localStorage.getItem("permissions")) {
          await invoke("reset_screen_permissions");
          const permissions = JSON.parse(
            localStorage.getItem("permissions") || "{}"
          );
          permissions.screen = false;
          permissions.confirmed = false;
          localStorage.setItem("permissions", JSON.stringify(permissions));
          toast.error(
            "New version downloaded - screen permissions have been reset"
          );
        }
      } else if (storedVersion !== appVersion) {
        console.log("New version downloaded");
        localStorage.setItem("cap_test_build_version", appVersion);
        await invoke("reset_screen_permissions");
        const permissions = JSON.parse(
          localStorage.getItem("permissions") || "{}"
        );
        permissions.screen = false;
        permissions.confirmed = false;
        localStorage.setItem("permissions", JSON.stringify(permissions));
        toast.error(
          "New version downloaded - screen permissions have been reset"
        );
      }
    };

    checkVersion();
  }, []);

  useEffect(() => {
    const checkPermissions = setInterval(() => {
      const updatedPermissions = getPermissions();
      if (
        updatedPermissions &&
        updatedPermissions.confirmed !== permissions.confirmed
      ) {
        setPermissions(updatedPermissions);
      }
    }, 1000);

    return () => clearInterval(checkPermissions);
  }, [permissions]);

  useEffect(() => {
    const checkSession = setInterval(() => {
      const session = localStorage.getItem("session");
      if (session) {
        const { token, expires } = JSON.parse(session);
        if (token && new Date(expires * 1000) > new Date()) {
          setIsSignedIn(true);
          clearInterval(checkSession);
        }
      }
      setLoading(false);
    }, 1000);

    return () => clearInterval(checkSession);
  }, []);

  useEffect(() => {
    if (isSignedIn && !cameraWindowOpen) {
      initializeCameraWindow();
      setCameraWindowOpen(true);
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
      {isSignedIn ? (
        <>
          <WindowActions />
          {!permissions || permissions.confirmed === false ? (
            <Permissions />
          ) : (
            <Recorder />
          )}
        </>
      ) : (
        <SignIn />
      )}
    </div>
  );
}
