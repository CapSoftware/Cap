import { Fit, Layout, useRive } from "@rive-app/react-canvas";
import { forwardRef, memo, useImperativeHandle } from "react";

export interface ProArtRef {
	playHoverAnimation: () => void;
	playDefaultAnimation: () => void;
}

export const ProArt = memo(
	forwardRef<ProArtRef>((_, ref) => {
		const { rive, RiveComponent: ProRive } = useRive({
			src: "/rive/pricing.riv",
			artboard: "pro",
			animations: "idle",
			autoplay: false,
			layout: new Layout({
				fit: Fit.Contain,
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

		return (
			<ProRive className="w-full max-w-[210px] mx-auto h-[195px] relative bottom-5" />
		);
	}),
);
