import clsx from "clsx";
import type { CSSProperties, ReactNode } from "react";
import { ONBOARDING_PROGRESS_TOTAL } from "../onboarding-flow";

export const BoilFilter = ({ id }: { id: string }) => (
	<svg className="absolute size-0" aria-hidden="true" focusable="false">
		<defs>
			<filter id={id} x="-15%" y="-15%" width="130%" height="130%">
				<feTurbulence
					type="fractalNoise"
					baseFrequency="0.05"
					numOctaves="2"
					seed="1"
					result="noise"
				>
					<animate
						attributeName="seed"
						values="1;3;5;7"
						dur="0.6s"
						repeatCount="indefinite"
						calcMode="discrete"
					/>
				</feTurbulence>
				<feDisplacementMap
					in="SourceGraphic"
					in2="noise"
					scale="2.6"
					xChannelSelector="R"
					yChannelSelector="G"
				/>
			</filter>
		</defs>
	</svg>
);

export const CapWordmark = ({ className }: { className?: string }) => (
	<svg
		className={className}
		xmlns="http://www.w3.org/2000/svg"
		fill="none"
		viewBox="0 0 103 40"
		role="img"
		aria-label="Cap"
	>
		<path
			fill="#4785FF"
			d="M20 36c8.837 0 16-7.163 16-16S28.837 4 20 4 4 11.164 4 20s7.164 16 16 16"
		/>
		<path
			fill="#ADC9FF"
			d="M20 33c7.18 0 13-5.82 13-13S27.18 7 20 7 7 12.82 7 20s5.82 13 13 13"
		/>
		<path
			fill="#fff"
			d="M20 30c5.523 0 10-4.477 10-10s-4.477-10-10-10-10 4.477-10 10 4.477 10 10 10"
		/>
		<path
			fill="currentColor"
			d="M58.416 30.448c-5.404 0-9.212-3.864-9.212-10.36 0-6.384 3.668-10.416 9.268-10.416 5.068 0 7.784 2.66 8.624 7.168l-3.808.196c-.476-2.604-2.072-4.2-4.816-4.2-3.388 0-5.488 2.828-5.488 7.252 0 4.48 2.156 7.196 5.46 7.196 2.94 0 4.508-1.708 4.956-4.564l3.808.196c-.784 4.676-3.752 7.532-8.792 7.532m16.23-.112c-3.137 0-5.209-1.484-5.209-4.088 0-2.576 1.596-3.948 4.872-4.592l4.956-.98c0-2.1-.98-3.192-2.856-3.192-1.764 0-2.716.812-3.052 2.324l-3.668-.168c.588-3.136 2.996-4.928 6.72-4.928 4.256 0 6.44 2.24 6.44 6.216v5.432c0 .812.28 1.036.84 1.036h.476V30c-.224.056-.812.112-1.288.112-1.624 0-2.828-.588-3.136-2.436-.728 1.596-2.632 2.66-5.096 2.66m.727-2.604c2.38 0 3.892-1.512 3.892-3.78v-.84l-3.864.784c-1.596.308-2.24.98-2.24 2.016 0 1.176.784 1.82 2.212 1.82M86.874 34.2V15.048h3.444l.056 2.212c.868-1.652 2.52-2.548 4.48-2.548 4.256 0 6.356 3.5 6.356 7.812s-2.128 7.812-6.384 7.812c-1.904 0-3.556-.924-4.368-2.38V34.2zm7.112-6.776c2.184 0 3.5-1.82 3.5-4.9s-1.316-4.9-3.5-4.9-3.528 1.652-3.528 4.9 1.316 4.9 3.528 4.9"
		/>
	</svg>
);

export const LoomMark = ({
	className,
	size = 18,
}: {
	className?: string;
	size?: number;
}) => (
	<svg
		className={className}
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="none"
		aria-hidden="true"
	>
		<path
			fill="#625DF5"
			d="M15 7.222h-4.094l3.546-2.047-.779-1.35-3.545 2.048 2.046-3.546-1.349-.779L8.78 5.093V1H7.22v4.094L5.174 1.548l-1.348.779 2.046 3.545-3.545-2.046-.779 1.348 3.546 2.047H1v1.557h4.093l-3.545 2.047.779 1.35 3.545-2.047-2.047 3.545 1.35.779 2.046-3.546V15h1.557v-4.094l2.047 3.546 1.349-.779-2.047-3.546 3.545 2.047.779-1.349-3.545-2.046h4.093L15 7.222zm-7 2.896a2.126 2.126 0 110-4.252 2.126 2.126 0 010 4.252z"
		/>
	</svg>
);

export const LOOM_MARK_PATH =
	"M15 7.222h-4.094l3.546-2.047-.779-1.35-3.545 2.048 2.046-3.546-1.349-.779L8.78 5.093V1H7.22v4.094L5.174 1.548l-1.348.779 2.046 3.545-3.545-2.046-.779 1.348 3.546 2.047H1v1.557h4.093l-3.545 2.047.779 1.35 3.545-2.047-2.047 3.545 1.35.779 2.046-3.546V15h1.557v-4.094l2.047 3.546 1.349-.779-2.047-3.546 3.545 2.047.779-1.349-3.545-2.046h4.093L15 7.222zm-7 2.896a2.126 2.126 0 110-4.252 2.126 2.126 0 010 4.252z";

export const SceneCursor = ({ name }: { name: string }) => (
	<g className="ob-cursor" style={{ "--cursor": name } as CSSProperties}>
		<path
			d="M 0 0 L 0 17 L 4.5 12.8 L 7.6 19.6 L 10.4 18.4 L 7.4 11.7 L 13 11.4 Z"
			fill="var(--ob-ink)"
			stroke="#fff"
			strokeWidth="1.4"
			strokeLinejoin="round"
		/>
	</g>
);

export const SceneRipple = ({
	x,
	y,
	at,
	r = 12,
}: {
	x: number;
	y: number;
	at: number;
	r?: number;
}) => (
	<circle
		className="ob-ripple"
		cx={x}
		cy={y}
		r={r}
		fill="var(--ob-accent)"
		style={{ "--at": at } as CSSProperties}
	/>
);

const SPARK_SHAPE = (x: number, y: number, s: number) =>
	`M ${x} ${y - 2 * s} L ${x} ${y - s * 0.6} M ${x} ${y + s * 0.6} L ${x} ${y + 2 * s} M ${x - 2 * s} ${y} L ${x - s * 0.6} ${y} M ${x + s * 0.6} ${y} L ${x + 2 * s} ${y}`;

export const LoopSparks = ({
	points,
	at,
}: {
	points: readonly (readonly [number, number, number])[];
	at: number;
}) => (
	<>
		{points.map(([x, y, s], index) => (
			<path
				key={`${x}-${y}`}
				className="ob-loop-spark"
				d={SPARK_SHAPE(x, y, s)}
				style={{ "--at": at + index * 0.012 } as CSSProperties}
			/>
		))}
	</>
);

export const Sparks = ({
	points,
	delay = 0.6,
}: {
	points: readonly (readonly [number, number, number])[];
	delay?: number;
}) => (
	<>
		{points.map(([x, y, s], index) => (
			<path
				key={`${x}-${y}`}
				className="ob-spark"
				d={SPARK_SHAPE(x, y, s)}
				style={{ "--d": `${delay + index * 0.12}s` } as CSSProperties}
			/>
		))}
	</>
);

const PROGRESS_MARKS = Array.from(
	{ length: ONBOARDING_PROGRESS_TOTAL },
	(_, mark) => mark,
);

export const ProgressMarks = ({ index }: { index: number }) => (
	<div className="flex items-center gap-1.5">
		<span className="sr-only">
			Step {index + 1} of {ONBOARDING_PROGRESS_TOTAL}
		</span>
		{PROGRESS_MARKS.map((mark) => (
			<svg
				key={mark}
				viewBox="0 0 40 10"
				className="h-2.5 w-8 overflow-visible sm:w-10"
				aria-hidden="true"
			>
				<path
					pathLength={1}
					className={clsx(
						"ob-progress-mark",
						mark < index
							? "is-done"
							: mark === index
								? "is-current"
								: "is-next",
					)}
					d="M 3 6 C 10 2.5 16 7.5 22 4.5 C 27 2.5 32 6.5 37 4.8"
				/>
			</svg>
		))}
	</div>
);

const SQUIGGLE =
	"M 6 14 q 6 -7 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0";

export const SquiggleProgress = ({ progress }: { progress: number | null }) => (
	<div className="flex w-full items-center gap-3">
		<svg
			viewBox="0 0 360 26"
			preserveAspectRatio="none"
			className="h-[22px] min-w-0 flex-1 overflow-visible"
			aria-hidden="true"
		>
			<path className="ob-squiggle-track" pathLength={100} d={SQUIGGLE} />
			<path
				className={clsx(
					"ob-squiggle-progress",
					progress === null && "is-waiting",
				)}
				pathLength={100}
				d={SQUIGGLE}
				style={
					progress === null
						? undefined
						: { strokeDashoffset: 100 - Math.round(progress * 100) }
				}
			/>
		</svg>
		<span
			className={clsx(
				"w-11 shrink-0 text-right text-[15px] font-medium tabular-nums transition-opacity",
				progress === null && "opacity-0",
			)}
		>
			{Math.round((progress ?? 0) * 100)}%
		</span>
	</div>
);

const STEP_RING =
	"M 13 2.2 C 19.5 2 24 6.6 23.8 13 C 23.6 19.6 18.8 23.9 12.6 23.8 C 6.3 23.6 2.1 19.2 2.2 12.8 C 2.3 7.2 6.4 2.6 12.2 2.3";

export type ExplainerStep = { title: string; body?: ReactNode };

export const Explainer = ({
	scene,
	steps,
	loopSeconds,
	label,
	className,
	layout = "stacked",
}: {
	scene: ReactNode;
	steps: readonly [ExplainerStep, ExplainerStep, ExplainerStep];
	loopSeconds: number;
	label: string;
	className?: string;
	layout?: "stacked" | "split";
}) => (
	<figure
		className={clsx(
			"ob-card overflow-hidden p-2.5 sm:p-3",
			layout === "split" &&
				"md:grid md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] md:items-center md:gap-2",
			className,
		)}
		style={{ "--loop": `${loopSeconds}s` } as CSSProperties}
	>
		<div className="ob-scene-frame overflow-hidden px-2 py-3 sm:px-4 sm:py-4">
			{scene}
		</div>
		<figcaption className="px-2.5 pb-2 pt-4 sm:px-4 sm:pb-3">
			<p className="sr-only">{label}</p>
			<ol className="flex flex-col gap-3.5">
				{steps.map((step, index) => (
					<li
						key={step.title}
						className="ob-step flex items-start gap-3"
						style={{ "--i": index } as CSSProperties}
					>
						<span className="relative flex size-[26px] shrink-0 items-center justify-center">
							<svg
								viewBox="0 0 26 26"
								className="absolute inset-0 size-full overflow-visible"
								aria-hidden="true"
							>
								<path className="ob-step-ring" d={STEP_RING} />
							</svg>
							<span className="ob-step-num text-[13px] font-medium tabular-nums">
								{index + 1}
							</span>
						</span>
						<span className="ob-step-text flex min-w-0 flex-col pt-[3px]">
							<span className="text-[15px] font-medium leading-snug">
								{step.title}
							</span>
							{step.body && (
								<span className="mt-0.5 text-[13.5px] leading-relaxed text-[var(--ob-ink-soft)]">
									{step.body}
								</span>
							)}
						</span>
					</li>
				))}
			</ol>
		</figcaption>
	</figure>
);
