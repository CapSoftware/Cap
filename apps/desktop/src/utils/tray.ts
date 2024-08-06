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
import { toMonospaceUnicodeString } from "./helpers";

const TRAY_ID = "cap_main";
const TRAY_ICON_DEFAULT = "icons/tray-default-icon.png";
const TRAY_ICON_STOP = "icons/tray-stop-icon.png";

let handle: TrayIcon | null = null;

export const setTrayMenu = async (
  devices: Device[] = [],
  selectedAudio: Device | null = null,
  selectedVideo: Device | null = null
) => {
  if (!handle) {
    handle = await TrayIcon.getById(TRAY_ID);
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

  const items = [];
  if (devices.length !== 0) {
    items.push(
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
      })
    );
  }

  items.push(
    await MenuItem.new({
      text: "Show",
      action: () => {
        WebviewWindow.getByLabel("main")?.setFocus();
      },
    }),
    await PredefinedMenuItem.new({
      text: "Quit",
      item: "Quit",
    })
  );

  handle.setMenu(await Menu.new({ items: items }));
};

export const setTrayStopIcon = async (showStopIcon: boolean) => {
  await handle?.setIcon(showStopIcon ? TRAY_ICON_STOP : TRAY_ICON_DEFAULT);
  await handle?.setIconAsTemplate(true);
};

export const setTrayTitle = async (title: string | null) => {
  handle?.setTitle(title);
};

const selectDevice = (kind: DeviceKind, device: Device | null) =>
  emit("cap://av/set-device", { type: kind, device: device }).catch((error) =>
    console.log("Failed to emit cap://av/set-device event:", error)
  );
