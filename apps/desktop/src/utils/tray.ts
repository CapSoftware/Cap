import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { TrayIcon } from "@tauri-apps/api/tray";
import { emit } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

const TRAY_ID = "cap_main";
const TRAY_ICON_DEFAULT = "icons/tray-default-icon.png";
const TRAY_ICON_STOP = "icons/tray-stop-icon.png";

export const initTrayMenu = async () => {
  (await TrayIcon.getById(TRAY_ID))?.close();

  return TrayIcon.new({
    id: TRAY_ID,
    menuOnLeftClick: false,
    // action: (event) => {
    //   if ("click" in event && event.click.button_state === "Up") {
    //     emit("cap://tray/clicked", event.click).catch((error) =>
    //       console.log("Failed to emit tray event:", error)
    //     );
    //   }
    // },
    icon: TRAY_ICON_DEFAULT,
    iconAsTemplate: true,
  });
};

// TODO: Improve this. This might not work properly on Linux.
export const setTrayMenu = async () => {
  let tray = await TrayIcon.getById(TRAY_ID);

  console.log(`setTryMenu: ${tray?.id}`);

  if (!tray) {
    tray = await initTrayMenu();
  }

  tray.setMenu(
    await Menu.new({
      items: [
        // await Submenu.new({
        //   id: "audio_submenu",
        //   text: "Microphone",
        //   items: [...(await createDeviceSubmenu("audioinput", selectedAudio))],
        // }),
        // await Submenu.new({
        //   id: "video_submenu",
        //   text: "Camera",
        //   items: [...(await createDeviceSubmenu("videoinput", selectedVideo))],
        // }),
        // await PredefinedMenuItem.new({
        //   item: "Separator",
        // }),
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
      ],
    })
  );
};

export const setTrayStopIcon = async (stopIconEnabled: boolean) => {
  const tray = await TrayIcon.getById(TRAY_ID);
  if (!tray) {
    console.error("No system tray found.");
    return;
  }

  tray.setIcon(stopIconEnabled ? TRAY_ICON_STOP : TRAY_ICON_DEFAULT);
};

// const selectDevice = (kind: DeviceKind, device: Device | null) =>
//   emit("change-device", { type: kind, device: device }).catch((error) =>
//     console.log("Failed to emit change-device event:", error)
//   );
