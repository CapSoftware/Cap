import { Fit, Layout, useRive } from "@rive-app/react-canvas";
import { memo, useEffect } from "react";

export const ProArt = memo(({ cardHover }: { cardHover: boolean }) => {
  const { rive, RiveComponent: ProRive } = useRive({
    src: "/rive/pricing.riv",
    artboard: "pro",
    animations: ["items-coming-in"],
    layout: new Layout({
      fit: Fit.Cover,
    }),
  });
  
  useEffect(() => {
    if (!rive) return;
    if (cardHover) {
      rive.play("items-coming-out");
    } else {
      rive.play("items-coming-in");
    }
  }, [cardHover, rive]);
  
  return <ProRive className="w-full max-w-[210px] mx-auto h-[175px]" />;
});
