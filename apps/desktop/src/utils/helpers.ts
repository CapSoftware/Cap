import { appWindow, LogicalPosition } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/api/shell";
import { MediaDeviceContextData } from "./recording/MediaDeviceContext";

export const setWindowPosition = (
  position: "bottom_center" | "bottom_right"
) => {
  appWindow.outerSize().then((size) => {
    const appWidth = size.width / 2;
    const appHeight = size.height / 2;
    const windowHeight = window.screen.availHeight;
    const windowWidth = window.screen.availWidth;
    const calculatedWidth = (windowWidth - appWidth) / 2;
    const calculatedHeight = (windowHeight - appHeight) / 2;

    switch (position) {
      case "bottom_center":
        appWindow.setPosition(
          new LogicalPosition(calculatedWidth, calculatedHeight)
        );
        return;
      case "bottom_right":
        appWindow.setPosition(
          new LogicalPosition(
            windowWidth - appWidth - 75,
            windowHeight - appHeight
          )
        );
        return;
    }
  });
};

export const openLinkInBrowser = async (url: string) => {
  await open(url);

  return;
};

export function concatenateTypedArrays(
  constructor: new (arg0: number) => any,
  ...arrays: any[]
) {
  let totalLength = 0;
  for (const arr of arrays) {
    totalLength += arr.length;
  }
  const result = new constructor(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

export const getVideoSettings = async (
  videoDevice: MediaDeviceContextData["selectedVideoDevice"]
) => {
  if (!videoDevice) {
    return Promise.reject("Video device not selected");
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(
      (device) => device.kind === "videoinput"
    );
    const videoDeviceInfo = videoDevices[videoDevice.index].deviceId;

    if (!videoDeviceInfo) {
      return Promise.reject("Cannot find video device info");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: videoDeviceInfo },
      },
    });

    const settings = stream.getVideoTracks()[0].getSettings();
    stream.getTracks().forEach((track) => track.stop());

    return {
      framerate: String(settings.frameRate),
      resolution: settings.width + "x" + settings.height,
    };
  } catch (error) {
    console.error("Error obtaining video settings:", error);
    return {};
  }
};

export const requestMediaDevicesPermission = async () => {
  try {
    await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    console.log("Permissions to access media devices have been granted.");
  } catch (error) {
    console.error("Permissions to access media devices were denied.", error);
  }
};
