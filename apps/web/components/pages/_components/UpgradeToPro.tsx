"use client";

import { Button } from "@cap/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Rive, useRive } from "@/lib/rive";

type IdleWindow = Window & {
	requestIdleCallback?: (
		callback: IdleRequestCallback,
		options?: IdleRequestOptions,
	) => number;
	cancelIdleCallback?: (handle: number) => void;
};

const RIVE_CLASS =
	"w-[80px] scale-[0.9] h-[62px] bottom-[22.5%] -left-2 absolute inset-y-0 my-auto";

const ProRiveArt = ({ onReady }: { onReady: (rive: Rive | null) => void }) => {
	const { rive, RiveComponent } = useRive({
		src: "/rive/pricing.riv",
		artboard: "pro",
		animations: "idle",
		autoplay: false,
	});

	useEffect(() => {
		onReady(rive);
	}, [rive, onReady]);

	return <RiveComponent className={RIVE_CLASS} />;
};

const UpgradeToPro = ({
	text = "Upgrade To Cap Pro",
	onClick,
}: {
	text?: string;
	onClick?: () => void;
}) => {
	const [shouldLoad, setShouldLoad] = useState(false);
	const riveRef = useRef<Rive | null>(null);

	useEffect(() => {
		if (shouldLoad) return;

		const idleWindow = window as IdleWindow;
		if (idleWindow.requestIdleCallback) {
			const handle = idleWindow.requestIdleCallback(() => setShouldLoad(true), {
				timeout: 2000,
			});
			return () => idleWindow.cancelIdleCallback?.(handle);
		}

		const timeout = window.setTimeout(() => setShouldLoad(true), 1000);
		return () => window.clearTimeout(timeout);
	}, [shouldLoad]);

	const handleReady = useCallback((rive: Rive | null) => {
		riveRef.current = rive;
	}, []);

	return (
		<Button
			href="/pricing"
			onClick={onClick}
			onMouseEnter={() => {
				setShouldLoad(true);
				const rive = riveRef.current;
				if (rive) {
					rive.stop();
					rive.play("items-coming-out");
				}
			}}
			className="flex overflow-visible w-full max-w-[220px] relative gap-3 justify-evenly items-center cursor-pointer"
			onMouseLeave={() => {
				const rive = riveRef.current;
				if (rive) {
					rive.stop();
					rive.play("items-coming-in");
				}
			}}
			size="lg"
			variant="blue"
		>
			{shouldLoad && <ProRiveArt onReady={handleReady} />}
			<p className="relative left-5 font-medium text-white">{text}</p>
		</Button>
	);
};

export default UpgradeToPro;
