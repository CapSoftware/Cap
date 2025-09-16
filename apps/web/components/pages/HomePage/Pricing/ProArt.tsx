import { Fit, Layout, useRive } from "@rive-app/react-canvas";
import clsx from "clsx";
import { forwardRef, memo, useImperativeHandle } from "react";

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
			<ProRive
				className={clsx(
					className,
					"relative bottom-5 mx-auto w-full max-w-[210px] h-[195px]",
				)}
			/>
		);
	}),
);
