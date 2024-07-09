"use client";

import { Button, LogoBadge } from "@cap/ui";
import { useEffect, useState } from "react";
import { savePermissions, getPermissions } from "@/utils/helpers";
import * as commands from "@/utils/commands";
import { invoke } from "@tauri-apps/api/tauri";

export const Permissions = () => {
  const permissionsOpened = {
    screen: false,
    camera: false,
    microphone: false,
  };

  const [permissions, setPermissions] = useState({
    screen: false,
    camera: false,
    microphone: false,
  });

  const checkScreenCapture = async () => {
    const hasAccess = await commands.hasScreenCaptureAccess();
    if (hasAccess) {
      await savePermissions("screen", true);
      setPermissions((prev) => ({
        ...prev,
        screen: true,
      }));
    }
  };

  const checkCameraAccess = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      await savePermissions("camera", true);
      setPermissions((prev) => ({
        ...prev,
        camera: true,
      }));
      stream.getTracks().forEach((track) => track.stop());
    } catch (error) {
      navigator.permissions
        .query({ name: "camera" as PermissionName })
        .then((permissionStatus) => {
          if (permissionStatus.state === "denied") {
            console.log("Camera access denied");
          } else {
            permissionStatus.onchange = () => {
              if (permissionStatus.state === "denied") {
                console.log("Camera access denied");
              } else {
                checkCameraAccess();
              }
            };
          }
        });
      console.log("Camera access denied");
    }
  };

  const checkMicrophoneAccess = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Assuming access is granted if the above line doesn't throw an error
      await savePermissions("microphone", true);
      setPermissions((prev) => ({
        ...prev,
        microphone: true,
      }));
      stream.getTracks().forEach((track) => track.stop());
    } catch (error) {
      navigator.permissions
        .query({ name: "microphone" as PermissionName })
        .then((permissionStatus) => {
          if (permissionStatus.state === "denied") {
            console.log("Microphone access denied");
          } else {
            permissionStatus.onchange = () => {
              if (permissionStatus.state === "denied") {
                console.log("Microphone access denied");
              } else {
                checkMicrophoneAccess();
              }
            };
          }
        });
      console.log("Microphone access denied");
    }
  };

  useEffect(() => {
    const checkPermissions = async () => {
      if (!permissions.screen) {
        checkScreenCapture();
      }
      if (!permissions.camera) {
        await checkCameraAccess();
      }
      if (!permissions.microphone) {
        await checkMicrophoneAccess();
      }
    };

    const checkPermissionInterval = setInterval(checkPermissions, 1000);

    return () => clearInterval(checkPermissionInterval);
  }, [permissions]);

  const handlePermissionOpened = (permission: string) => {
    if (permission === "screen") {
      commands.openScreenCapturePreferences();
    } else if (permission === "camera") {
      commands.openCameraPreferences();
    } else if (permission === "microphone") {
      commands.openMicPreferences();
    }
  };

  const handleAllPermissionsEnabled = async () => {
    await savePermissions("confirmed", true);
    if (window.fathom !== undefined) {
      window.fathom.trackEvent("permissions_enabled");
    }
  };

  useEffect(() => {
    const fetchPermissions = async () => {
      const fetchedPermissions = await getPermissions();
      setPermissions(
        fetchedPermissions || {
          screen: false,
          camera: false,
          microphone: false,
        }
      );
    };
    fetchPermissions();
  }, []);

  const allPermissionsEnabled = Object.entries(permissions)
    .filter(([key]) => key !== "confirmed")
    .every(([, value]) => value);

  return (
    <div data-tauri-drag-region className="w-full space-y-3 px-3">
      <div className="text-center">
        <LogoBadge className="w-12 h-auto mx-auto mb-2" />
        <h1 className="text-lg">Welcome to Cap</h1>
        <p className="text-sm">
          Enable permissions to get started. Click "Confirm" after enabling each
          permission.
        </p>
      </div>
      <div className="space-y-3">
        {Object.keys(permissionsOpened).map((permission) => (
          <div
            key={permission}
            className="w-full rounded-full bg-gray-400 bg-opacity-50 py-3 px-4 flex items-center justify-between"
          >
            <div className="flex items-center">
              <div></div>
              <div>
                <p className="font-semibold text-sm capitalize">{permission}</p>
                <p className="text-xs">To share your {permission}</p>
              </div>
            </div>
            <div>
              <Button
                size="sm"
                disabled={permissions && permissions[permission] === true}
                variant={
                  permissions && permissions[permission] === true
                    ? "default"
                    : "outline"
                }
                onClick={() => {
                  handlePermissionOpened(permission);
                }}
              >
                {permissions && permissions[permission] === true
                  ? "Enabled"
                  : "Enable"}
              </Button>
            </div>
          </div>
        ))}
      </div>
      <div>
        <Button
          onClick={() => {
            handleAllPermissionsEnabled();
          }}
          className="w-full"
          disabled={!allPermissionsEnabled}
        >
          Continue
        </Button>
      </div>
    </div>
  );
};
