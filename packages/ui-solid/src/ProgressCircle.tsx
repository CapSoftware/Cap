import { cva, type VariantProps } from "cva";
import type { ComponentProps } from "solid-js";
import { createMemo } from "solid-js";

const containerStyles = cva(
	"flex items-center justify-center relative",
	{
		defaultVariants: {
			size: "md",
		},
		variants: {
			size: {
				xs: "w-3 h-3",
				sm: "w-4 h-4",
				md: "w-5 h-5",
				lg: "w-6 h-6",
				xl: "w-8 h-8",
			},
		},
	},
);

const strokeStyles = cva(
	"",
	{
		defaultVariants: {
			variant: "default",
		},
		variants: {
			variant: {
				default: "stroke-gray-12",
				primary: "stroke-blue-10",
				white: "stroke-white",
				current: "stroke-current",
			},
		},
	},
);

const backgroundStyles = cva(
	"",
	{
		defaultVariants: {
			variant: "default",
		},
		variants: {
			variant: {
				default: "stroke-gray-6",
				primary: "stroke-blue-5",
				white: "stroke-white/20",
				current: "stroke-current/20",
			},
		},
	},
);

type ProgressCircleProps = VariantProps<typeof containerStyles> & 
	VariantProps<typeof strokeStyles> & 
	Omit<ComponentProps<"div">, "children"> & {
		progress: number; // 0-100
		strokeWidth?: number;
	};

export function ProgressCircle(props: ProgressCircleProps) {
	const progress = () => Math.max(0, Math.min(100, props.progress));
	const strokeWidth = () => props.strokeWidth ?? 2;
	
	const radius = createMemo(() => {
		const sizeMap = { xs: 6, sm: 8, md: 10, lg: 12, xl: 16 };
		return sizeMap[props.size ?? "md"] - strokeWidth();
	});
	
	const circumference = createMemo(() => 2 * Math.PI * radius());
	const strokeDashoffset = createMemo(() => 
		circumference() - (progress() / 100) * circumference()
	);
	
	const center = createMemo(() => {
		const sizeMap = { xs: 6, sm: 8, md: 10, lg: 12, xl: 16 };
		return sizeMap[props.size ?? "md"];
	});

	return (
		<div
			{...props}
			class={containerStyles({ size: props.size, class: props.class })}
		>
			<svg
				class="w-full h-full transform -rotate-90"
				viewBox={`0 0 ${center() * 2} ${center() * 2}`}
				aria-label={`Progress: ${progress()}%`}
				role="progressbar"
				aria-valuenow={progress()}
				aria-valuemin={0}
				aria-valuemax={100}
			>
				{/* Background circle */}
				<circle
					cx={center()}
					cy={center()}
					r={radius()}
					fill="none"
					stroke-width={strokeWidth()}
					class={backgroundStyles({ variant: props.variant })}
				/>
				{/* Progress circle */}
				<circle
					cx={center()}
					cy={center()}
					r={radius()}
					fill="none"
					stroke-width={strokeWidth()}
					stroke-linecap="round"
					stroke-dasharray={circumference().toString()}
					stroke-dashoffset={strokeDashoffset().toString()}
					class={`transition-all duration-300 ${strokeStyles({ variant: props.variant })}`}
				/>
			</svg>
		</div>
	);
}
