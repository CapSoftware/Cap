"use client";

import { classNames } from "@cap/utils/helpers";
import { useDetectPlatform } from "hooks/useDetectPlatform";
import {
	type ComponentType,
	lazy,
	Suspense,
	useEffect,
	useRef,
	useState,
} from "react";
import { DemoPlatformProvider } from "../demo/platform";
import { Panel, type Tone } from "./layout";

type StageName =
	| "instant"
	| "studio"
	| "screenshot"
	| "ai"
	| "ownership"
	| "agents";

const STAGES: Record<StageName, ComponentType> = {
	instant: lazy(() =>
		import("./instant").then((m) => ({ default: m.InstantStage })),
	),
	studio: lazy(() =>
		import("./studio").then((m) => ({ default: m.StudioStage })),
	),
	screenshot: lazy(() =>
		import("./screenshot").then((m) => ({ default: m.ScreenshotStage })),
	),
	ai: lazy(() => import("./ai").then((m) => ({ default: m.AiStage }))),
	ownership: lazy(() =>
		import("./ownership").then((m) => ({ default: m.OwnershipStage })),
	),
	agents: lazy(() =>
		import("./agents").then((m) => ({ default: m.AgentsStage })),
	),
};

const Placeholder = ({
	canvas,
	tone,
	caption,
}: {
	canvas: { w: number; h: number };
	tone: Tone;
	caption: boolean;
}) => (
	<div aria-hidden="true">
		<Panel tone={tone}>
			<div style={{ aspectRatio: `${canvas.w} / ${canvas.h}` }} />
		</Panel>
		{caption ? <div className="h-[76px]" /> : null}
	</div>
);

export const Stage = ({
	name,
	canvas,
	tone,
	caption = true,
	className,
}: {
	name: StageName;
	canvas: { w: number; h: number };
	tone: Tone;
	caption?: boolean;
	className?: string;
}) => {
	const ref = useRef<HTMLDivElement | null>(null);
	const [near, setNear] = useState(false);
	// Windows visitors see Windows windows, cursors and notifications;
	// everyone else gets macOS, the same rule as the hero demo.
	const { platform } = useDetectPlatform();
	const look = platform === "windows" ? "windows" : "macos";

	useEffect(() => {
		const el = ref.current;
		if (!el || near) return;
		const io = new IntersectionObserver(
			([entry]) => {
				if (entry?.isIntersecting) setNear(true);
			},
			{ rootMargin: "1200px 0px" },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [near]);

	const Loaded = STAGES[name];
	const placeholder = (
		<Placeholder canvas={canvas} tone={tone} caption={caption} />
	);
	return (
		<div ref={ref} className={classNames("min-w-0", className)}>
			{near ? (
				<DemoPlatformProvider value={look}>
					<Suspense fallback={placeholder}>
						<Loaded />
					</Suspense>
				</DemoPlatformProvider>
			) : (
				placeholder
			)}
		</div>
	);
};
