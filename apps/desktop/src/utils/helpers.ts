import { appWindow, LogicalPosition } from "@tauri-apps/api/window";

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
            windowWidth - appWidth - 125,
            windowHeight - appHeight - 25
          )
        );
        return;
    }
  });
};
