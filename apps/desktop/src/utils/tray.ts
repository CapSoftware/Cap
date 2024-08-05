import {
  CheckMenuItem,
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
} from "@tauri-apps/api/menu";
import { TrayIcon } from "@tauri-apps/api/tray";
import { emit } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Device, DeviceKind } from "./recording/MediaDeviceContext";
import { MenuItemBase } from "@tauri-apps/api/menu/base";

const TRAY_ID = "cap_main";
const TRAY_ICON_DEFAULT = "icons/tray-default-icon.png";
const TRAY_ICON_STOP = "icons/tray-stop-icon.png";

export const setTrayMenu = async (
  devices: Device[] = [],
  selectedAudio: Device | null = null,
  selectedVideo: Device | null = null
) => {
  let tray = await TrayIcon.getById(TRAY_ID);
  if (!tray) {
    console.error(`No tray found: ${TRAY_ID}`);
    return;
  }

  const createDeviceSubmenu = async (
    kind: DeviceKind,
    selected: Device | null
  ) => {
    const filteredDevices = devices.filter((device) => device.kind === kind);

    if (filteredDevices.length === 0) {
      return [
        await CheckMenuItem.new({ text: "No devices found.", enabled: false }),
      ];
    }

    return [
      await CheckMenuItem.new({
        id: `none_${kind}`,
        text: "None",
        checked: selected === null,
        action: (_) => selectDevice(kind, null),
      }),
      ...(await Promise.all(
        filteredDevices.map(
          async (device) =>
            await CheckMenuItem.new({
              id: device.id,
              text: device.label,
              checked: device.index === selected?.index,
              action: (_) => selectDevice(kind, device),
            })
        )
      )),
    ] satisfies CheckMenuItem[];
  };

  const items = [
    await Submenu.new({
      id: "audio_submenu",
      text: "Microphone",
      items: [...(await createDeviceSubmenu("audioinput", selectedAudio))],
    }),
    await Submenu.new({
      id: "video_submenu",
      text: "Camera",
      items: [...(await createDeviceSubmenu("videoinput", selectedVideo))],
    }),
    await PredefinedMenuItem.new({
      item: "Separator",
    }),
    await MenuItem.new({
      text: "Show",
      action: () => {
        WebviewWindow.getByLabel("main")?.setFocus();
      },
    }),
    await PredefinedMenuItem.new({
      text: "Quit",
      item: "Quit",
    }),
  ] satisfies MenuItemBase[];

  tray.setMenu(await Menu.new({ items: items }));
};

export const setTrayStopIcon = async (showStopIcon: boolean) => {
  const tray = await TrayIcon.getById(TRAY_ID);
  if (!tray) {
    console.error(`No tray found: ${TRAY_ID}`);
    return;
  }

  tray.setIcon(showStopIcon ? TRAY_ICON_STOP : TRAY_ICON_DEFAULT);
  tray.setIconAsTemplate(true);
};

const selectDevice = (kind: DeviceKind, device: Device | null) =>
  emit("cap://av/set-device", { type: kind, device: device }).catch((error) =>
    console.log("Failed to emit cap://av/set-device event:", error)
  );
