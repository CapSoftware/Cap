import { Fit, Layout, useRive } from "@rive-app/react-canvas";
import clsx from "clsx";
import { forwardRef, memo, useImperativeHandle } from "react";

export interface CommercialArtRef {
	playHoverAnimation: () => void;
	playDefaultAnimation: () => void;
}

interface Props {
	className?: string;
}

export const CommercialArt = memo(
	forwardRef<CommercialArtRef, Props>((props, ref) => {
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
			},
		}));

		return (
			<CommercialRive
				className={clsx(
					"w-full max-w-[100px] mx-auto h-[80px]",
					props.className,
				)}
			/>
		);
	}),
);
