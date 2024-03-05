import { Button, LogoBadge } from "@cap/ui";
import { useEffect, useState } from "react";
import { savePermissions, getPermissions } from "@/utils/helpers";
import { invoke } from "@tauri-apps/api/tauri";

export const Permissions = () => {
  const [permissionsOpened, setPermissionsOpened] = useState({
    screen: false,
    camera: false,
    microphone: false,
  });

  const [permissions, setPermissions] = useState({
    screen: false,
    camera: false,
    microphone: false,
  });

  const handlePermissionOpened = (permission: string) => {
    if (permission === "screen") {
      invoke("open_screen_capture_preferences");
    } else if (permission === "camera") {
      invoke("open_camera_preferences");
    } else if (permission === "microphone") {
      invoke("open_mic_preferences");
    }

    setPermissionsOpened((prev) => ({
      ...prev,
      [permission]: !prev[permission],
    }));
  };

  const handlePermissionConfirm = async (permission: string) => {
    await savePermissions(permission, true);
    setPermissions((prev) => ({
      ...prev,
      [permission]: true,
    }));
  };

  const handleAllPermissionsEnabled = async () => {
    await savePermissions("confirmed", true);
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
                    : permissionsOpened[permission] === true
                    ? "default"
                    : "outline"
                }
                onClick={() => {
                  permissionsOpened[permission] === true
                    ? handlePermissionConfirm(permission)
                    : handlePermissionOpened(permission);
                }}
              >
                {permissions && permissions[permission] === true
                  ? "Enabled"
                  : permissionsOpened[permission] === true
                  ? "Confirm"
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
