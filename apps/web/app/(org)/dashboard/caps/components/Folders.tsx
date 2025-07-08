"use client"

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

interface AllFoldersProps {
  color: "normal" | "blue" | "red" | "yellow";
  className?: string;
}


export const AllFolders = React.forwardRef<FolderHandle, AllFoldersProps>((props, ref) => {
  const { theme } = useTheme();


  const artboard = theme === "dark" && props.color === "normal" ? "folder" : props.color === "blue" ? "folder-blue" : props.color === "red" ? "folder-red" : props.color === "yellow" ? "folder-yellow" : "folder-dark";
  const { rive, RiveComponent: AllFoldersRive } = useRive({
    src: "/rive/dashboard.riv",
    artboard,
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

  return <AllFoldersRive key={theme + props.color} className={props.className} />
});
