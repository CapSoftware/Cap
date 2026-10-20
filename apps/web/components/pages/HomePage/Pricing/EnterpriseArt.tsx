import { classNames } from "@cap/utils";
import { forwardRef, memo, useImperativeHandle } from "react";
import { Alignment, Fit, Layout, useRive } from "@/lib/rive";

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
				alignment: Alignment.CenterLeft,
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
			<EnterpriseRive className={classNames("w-full h-full", className)} />
		);
	}),
);

EnterpriseArt.displayName = "EnterpriseArt";
