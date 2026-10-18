import { classNames } from "@cap/utils";
import { forwardRef, memo, useImperativeHandle } from "react";
import { Alignment, Fit, Layout, useRive } from "@/lib/rive";

export interface CommercialArtRef {
	playHoverAnimation: () => void;
	playDefaultAnimation: () => void;
}

interface CommercialArtProps {
	className?: string;
}

export const CommercialArt = memo(
	forwardRef<CommercialArtRef, CommercialArtProps>(({ className }, ref) => {
		const { rive, RiveComponent: CommercialRive } = useRive({
			src: "/rive/pricing.riv",
			artboard: "commercial",
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
					rive.play("cards");
				}
			},
			playDefaultAnimation: () => {
				if (rive) {
					rive.stop();
					rive.play("card-stack");
				}
			},
		}));

		return (
			<CommercialRive className={classNames("w-full h-full", className)} />
		);
	}),
);

CommercialArt.displayName = "CommercialArt";
