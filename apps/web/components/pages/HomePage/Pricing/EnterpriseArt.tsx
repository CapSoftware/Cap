import { Fit, Layout, useRive } from "@rive-app/react-canvas";
import clsx from "clsx";
import { forwardRef, memo, useImperativeHandle } from "react";

export interface EnterpriseArtRef {
	playHoverAnimation: () => void;
	playDefaultAnimation: () => void;
}

interface EnterpriseArtProps {
	className?: string;
}

export const EnterpriseArt = memo(
	forwardRef<EnterpriseArtRef, EnterpriseArtProps>(({ className }, ref) => {
		const { rive, RiveComponent: EnterpriseRive } = useRive({
			src: "/rive/pricing.riv",
			artboard: "enterprise",
			animations: "idle",
			autoplay: false,
			layout: new Layout({
				fit: Fit.Contain,
			}),
		});

		useImperativeHandle(ref, () => ({
			playHoverAnimation: () => {
				if (rive) {
					rive.play("out");
				}
			},
			playDefaultAnimation: () => {
				if (rive) {
					rive.play("idle");
				}
			},
		}));

		return (
			<EnterpriseRive
				className={clsx(className, "mx-auto w-full max-w-[200px] h-[120px]")}
			/>
		);
	}),
);
