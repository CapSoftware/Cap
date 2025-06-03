import { Fit, Layout, useRive } from "@rive-app/react-canvas";
import { forwardRef, memo, useImperativeHandle } from "react";

export interface CommercialArtRef {
  playHoverAnimation: () => void;
  playDefaultAnimation: () => void;
}

export const CommercialArt = memo(forwardRef<CommercialArtRef>((_, ref) => {
  const { rive, RiveComponent: CommercialRive } = useRive({
    src: "/rive/pricing.riv",
    artboard: "commercial",
    animations: "idle",
    autoplay: false,
    layout: new Layout({
      fit: Fit.Cover,
    }),
  });

  useImperativeHandle(ref, () => ({
    playHoverAnimation: () => {
      if (rive) {
        rive.stop();
        rive.play("cards");
      }
    },
    playDefaultAnimation: () => {
      if (rive) {
        rive.stop();
        rive.play("card-stack");
      }
    }
  }));

  return <CommercialRive className="w-full max-w-[200px] mx-auto h-[175px]" />;
}));

