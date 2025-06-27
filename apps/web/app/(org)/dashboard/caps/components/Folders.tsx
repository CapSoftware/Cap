import { Fit, Layout, useRive } from "@rive-app/react-canvas";
import { useTheme } from "../../Contexts";
import React, { useImperativeHandle } from "react";

export interface FolderHandle {
  play: (animationName: string) => void;
  stop: () => void;
}

export const NormalFolder = React.forwardRef<FolderHandle>((_, ref) => {
  const { theme } = useTheme();
  const { rive, RiveComponent: NormalFolderRive } = useRive({
    src: "/rive/dashboard.riv",
    artboard: theme === "dark" ? "folder" : "folder-dark",
    animations: "idle",
    autoplay: false,
    layout: new Layout({
      fit: Fit.Contain,
    }),
  });

  useImperativeHandle(ref, () => ({
    play: (animationName: string) => {
      if (!rive) return;
      rive.play(animationName);
    },
    stop: () => {
      if (!rive) return;
      rive.stop();
    }
  }), [rive]);

  return <NormalFolderRive key={theme + "folder-normal"} className="w-[50px] h-[50px]" />
});

export const BlueFolder = React.forwardRef<FolderHandle>((_, ref) => {
  const { rive, RiveComponent: BlueFolderRive } = useRive({
    src: "/rive/dashboard.riv",
    artboard: "folder-blue",
    animations: "idle",
    autoplay: false,
    layout: new Layout({
      fit: Fit.Contain,
    }),
  });

  useImperativeHandle(ref, () => ({
    play: (animationName: string) => {
      if (!rive) return;
      rive.play(animationName);
    },
    stop: () => {
      if (!rive) return;
      rive.stop();
    }
  }), [rive]);

  return <BlueFolderRive className="w-[50px] h-[50px]" />
});

export const RedFolder = React.forwardRef<FolderHandle>((_, ref) => {
  const { rive, RiveComponent: RedFolderRive } = useRive({
    src: "/rive/dashboard.riv",
    artboard: "folder-red",
    animations: "idle",
    autoplay: false,
    layout: new Layout({
      fit: Fit.Contain,
    }),
  });

  useImperativeHandle(ref, () => ({
    play: (animationName: string) => {
      if (!rive) return;
      rive.play(animationName);
    },
    stop: () => {
      if (!rive) return;
      rive.stop();
    }
  }), [rive]);

  return <RedFolderRive className="w-[50px] h-[50px]" />
});

export const YellowFolder = React.forwardRef<FolderHandle>((_, ref) => {
  const { rive, RiveComponent: YellowFolderRive } = useRive({
    src: "/rive/dashboard.riv",
    artboard: "folder-yellow",
    animations: "idle",
    autoplay: false,
    layout: new Layout({
      fit: Fit.Contain,
    }),
  });

  useImperativeHandle(ref, () => ({
    play: (animationName: string) => {
      if (!rive) return;
      rive.play(animationName);
    },
    stop: () => {
      if (!rive) return;
      rive.stop();
    }
  }), [rive]);

  return <YellowFolderRive className="w-[50px] h-[50px]" />
});
