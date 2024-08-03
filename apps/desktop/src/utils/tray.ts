import { CheckMenuItem, Menu, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { TrayIcon } from "@tauri-apps/api/tray";
import { Device, DeviceKind } from "./recording/MediaDeviceContext";
import { emit } from "@tauri-apps/api/event";

// TODO: Improve this. This might not work properly on Linux.
export const setTrayMenu = async (
  devices: Device[] = [],
  selectedAudio: Device | null = null,
  selectedVideo: Device | null = null,
) => {
  const tray = await TrayIcon.getById("cap_main");
  console.log(`Setting tray with devices: ${devices.length} for tray: ${tray}`);
  
  if (!tray) {
    console.error("No system tray found.");
    return;
  }

  const createDeviceSubmenu = async (kind: DeviceKind, selected: Device | null) => {
    const filteredDevices = devices.filter((device) => device.kind === kind);
    const menuItems: CheckMenuItem[] = [];

    if (filteredDevices.length === 0) {
      menuItems.push(await CheckMenuItem.new({ text: "No devices found.", enabled: false }));
    } else {
      menuItems.push(await CheckMenuItem.new({
        id: `none_${kind}`,
        text: "None",
        checked: selected === null,
        action: (_) => selectDevice(kind, null),
      }));

      menuItems.push(...await Promise.all(
        filteredDevices.map(async (device) => 
          await CheckMenuItem.new({
            id: device.id,
            text: device.label || `Unknown ${kind}`,
            checked: device?.index === selected?.index,
            action: (_) => selectDevice(kind, device),
          })
        )
      ));
    }

    return menuItems;
  };

  tray.setMenu(await Menu.new({
    items: [
      await Submenu.new({
        id: "audio_submenu",
        text: "Microphone",
        items: [...await createDeviceSubmenu("audioinput", selectedAudio)]
      }),
      await Submenu.new({
        id: "video_submenu",
        text: "Camera",
        items: [...await createDeviceSubmenu("videoinput", selectedVideo)]
      }),
      await PredefinedMenuItem.new({
        item: "Separator"
      }),
      await PredefinedMenuItem.new({
        item: "ShowAll"
      }),
      await PredefinedMenuItem.new({
        text: "Quit",
        item: "Quit"
      }),
    ]
  }));
};

const selectDevice = (kind: DeviceKind, device: Device | null) =>
  emit("change-device", { type: kind, device: device }).catch((error) =>
    console.log("Failed to emit change-device event:", error)
  );
