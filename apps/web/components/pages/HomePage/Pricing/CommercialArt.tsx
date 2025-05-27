import { Fit, Layout, useRive } from "@rive-app/react-canvas";
import { memo, useEffect } from "react";

export const CommercialArt = memo(({ cardHover }: { cardHover: boolean }) => {
  const { rive, RiveComponent: CommercialRive } = useRive({
    src: "/rive/pricing.riv",
    artboard: "commercial",
    animations: ["card-stack"],
    layout: new Layout({
      fit: Fit.Cover,
    }),
  });

  useEffect(() => {
    if (!rive) return;
    if (cardHover) {
      rive.play("cards");
    } else {
      rive.play("card-stack");
    }
  }, [cardHover, rive]);

  return <CommercialRive className="w-full max-w-[200px] mx-auto h-[175px]" />;
});
