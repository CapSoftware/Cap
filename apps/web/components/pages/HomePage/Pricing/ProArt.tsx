import { classNames } from "@cap/utils";
import { forwardRef, memo, useImperativeHandle } from "react";
import { Alignment, Fit, Layout, useRive } from "@/lib/rive";

export interface ProArtRef {
	playHoverAnimation: () => void;
	playDefaultAnimation: () => void;
}

interface ProArtProps {
	className?: string;
}

export const ProArt = memo(
	forwardRef<ProArtRef, ProArtProps>(({ className }, ref) => {
		const { rive, RiveComponent: ProRive } = useRive({
			src: "/rive/pricing.riv",
			artboard: "pro",
			animations: "idle",
			autoplay: false,
			layout: new Layout({
				fit: Fit.Contain,
				alignment: Alignment.CenterLeft,
			}),
		});

		useImperativeHandle(ref, () => ({
			playHoverAnimation: () => {
				if (rive) {
					rive.stop();
					rive.play("items-coming-out");
				}
			},
			playDefaultAnimation: () => {
				if (rive) {
					rive.stop();
					rive.play("items-coming-in");
				}
			},
		}));

		return <ProRive className={classNames("w-full h-full", className)} />;
	}),
);

ProArt.displayName = "ProArt";
