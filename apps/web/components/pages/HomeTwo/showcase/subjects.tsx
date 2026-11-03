"use client";

import { classNames } from "@cap/utils/helpers";
import { type CSSProperties, type ReactNode, useRef } from "react";
import { MacCursor, WindowsCursor } from "../cursors";
import { TrafficLights, WindowsCaptionControls } from "../demo/chrome";
import { PRESENTER, PresenterSources, useVideoAttrs } from "../demo/media";
import { OS_FONT, useIsWindowsDemo } from "../demo/platform";

export { PRESENTER };

import { useVideo } from "../scenes/engine";

export const INVOICE = { w: 680, h: 425 } as const;

export const INVOICE_SPOTS = {
	send: { x: 524, y: 360, w: 128, h: 34 },
	email: { x: 326, y: 140, w: 160, h: 20 },
	bank: { x: 172, y: 317, w: 176, h: 24 },
	total: { x: 540, y: 276, w: 112, h: 28 },
} as const;

const NAV = ["Overview", "Invoices", "Clients", "Payments", "Settings"];

const Field = ({
	label,
	value,
	style,
	valueStyle,
}: {
	label: string;
	value: ReactNode;
	style?: CSSProperties;
	valueStyle?: CSSProperties;
}) => (
	<div className="absolute" style={style}>
		<div className="text-[10.5px] font-medium text-[#8A8F98]">{label}</div>
		<div
			className="mt-1 text-[13.5px] font-medium text-[#1C1D21]"
			style={valueStyle}
		>
			{value}
		</div>
	</div>
);

export const BrowserBar = ({
	url,
	className,
	small,
}: {
	url: string;
	className?: string;
	small?: boolean;
}) => {
	const windows = useIsWindowsDemo();
	const pill = classNames(
		"flex items-center rounded-md bg-white text-[#6B7079] shadow-[0_0_0_1px_rgba(0,0,0,0.06)]",
		small ? "h-[20px] text-[10.5px]" : "h-[22px] text-[11px]",
	);
	if (windows) {
		return (
			<div
				className={classNames(
					"flex items-stretch border-b border-[#E5E5E5] bg-[#F3F3F3]",
					className,
				)}
				style={{ fontFamily: OS_FONT.windows }}
			>
				<div className="flex flex-1 items-center gap-2 pl-3">
					<span
						className={classNames(
							pill,
							"rounded-full px-3",
							small ? "w-[230px]" : "w-[270px]",
						)}
					>
						{url}
					</span>
				</div>
				<WindowsCaptionControls className="scale-90" />
			</div>
		);
	}
	return (
		<div
			className={classNames(
				"flex items-center border-b border-[#ECEDF0] bg-[#F7F7F8]",
				small ? "px-3" : "px-3.5",
				className,
			)}
		>
			<TrafficLights size={small ? 9 : 10} />
			<div
				className={classNames(
					pill,
					"mx-auto justify-center",
					small ? "w-[240px]" : "w-[260px]",
				)}
			>
				{url}
			</div>
			<div className={small ? "w-[40px]" : "w-[46px]"} />
		</div>
	);
};

export const AppBar = ({
	children,
	className,
	dark,
}: {
	children: ReactNode;
	className?: string;
	dark?: boolean;
}) => {
	const windows = useIsWindowsDemo();
	return (
		<div className={classNames("flex items-stretch", className)}>
			{windows ? null : (
				<span className="flex items-center pl-4 pr-1">
					<TrafficLights size={dark ? 12 : 10} />
				</span>
			)}
			<div
				className="flex min-w-0 flex-1 items-center gap-3 px-3"
				style={windows ? { fontFamily: OS_FONT.windows } : undefined}
			>
				{children}
			</div>
			{windows ? <WindowsCaptionControls light={dark} /> : null}
		</div>
	);
};

export const InvoicePage = ({
	sent = 0,
	press = 0,
	emailStyle,
	chrome = true,
}: {
	sent?: number;
	press?: number;
	emailStyle?: CSSProperties;
	chrome?: boolean;
}) => (
	<div
		className="relative overflow-hidden bg-white text-[#1C1D21]"
		style={{ width: INVOICE.w, height: INVOICE.h, fontWeight: 500 }}
	>
		{chrome ? (
			<BrowserBar
				url="ledgerly.app/invoices/new"
				className="absolute inset-x-0 top-0 h-9"
			/>
		) : null}

		<div
			className="absolute bottom-0 left-0 w-[150px] border-r border-[#ECEDF0] bg-[#FAFAFB] px-3 pt-4"
			style={{ top: chrome ? 36 : 0 }}
		>
			<div className="flex items-center gap-2 px-2 text-[13px] font-semibold">
				<span className="grid size-[18px] place-items-center rounded-[5px] bg-[#1C1D21] text-[10px] text-white">
					L
				</span>
				Ledgerly
			</div>
			<div className="mt-4 flex flex-col gap-0.5">
				{NAV.map((item) => (
					<div
						key={item}
						className={classNames(
							"rounded-md px-2 py-[5px] text-[12px]",
							item === "Invoices"
								? "bg-[#EDEEF1] text-[#1C1D21]"
								: "text-[#6B7079]",
						)}
					>
						{item}
					</div>
				))}
			</div>
		</div>

		<div
			className="absolute right-0 bottom-0 left-[150px]"
			style={{ top: chrome ? 36 : 0 }}
		>
			<div className="absolute left-7 top-[18px] text-[11px] text-[#8A8F98]">
				Invoices <span className="px-1 text-[#C2C5CC]">/</span> New invoice
			</div>
			<div className="absolute left-7 top-[38px] text-[21px] font-semibold tracking-[-0.02em]">
				Invoice #1042
			</div>
			<div className="absolute right-7 top-[42px] rounded-full bg-[#F1F2F4] px-2.5 py-[3px] text-[11px] text-[#6B7079]">
				{sent > 0.5 ? "Sent" : "Draft"}
			</div>

			<Field
				label="Bill to"
				value="Northwind Labs"
				style={{ left: 28, top: 88 }}
			/>
			<Field
				label="Email"
				value="billing@northwind.com"
				style={{ left: 180, top: 88 }}
				valueStyle={emailStyle}
			/>
			<Field label="Due" value="Nov 14, 2026" style={{ left: 378, top: 88 }} />

			<div className="absolute inset-x-7 top-[146px] flex border-b border-[#ECEDF0] pb-1.5 text-[10.5px] text-[#8A8F98]">
				<span className="flex-1">Item</span>
				<span className="w-12 text-right">Qty</span>
				<span className="w-24 text-right">Amount</span>
			</div>
			{[
				["Design retainer, October", "1", "$3,600.00"],
				["Usability study", "1", "$600.00"],
			].map(([item, qty, amount], i) => (
				<div
					key={item}
					className="absolute inset-x-7 flex border-b border-[#F2F3F5] py-2 text-[12.5px]"
					style={{ top: 172 + i * 33 }}
				>
					<span className="flex-1">{item}</span>
					<span className="w-12 text-right text-[#6B7079]">{qty}</span>
					<span className="w-24 text-right tabular-nums">{amount}</span>
				</div>
			))}
			<div className="absolute right-7 top-[244px] flex items-baseline gap-6 text-[12.5px]">
				<span className="text-[#8A8F98]">Total</span>
				<span className="text-[17px] font-semibold tabular-nums">
					$4,200.00
				</span>
			</div>

			<Field
				label="Pay to"
				value="Ledgerly Bank •••• 4821"
				style={{ left: 28, top: 268 }}
			/>

			<div
				className="absolute right-7 top-[324px] flex h-[34px] w-[128px] items-center justify-center rounded-[9px] text-[12.5px] text-white"
				style={{
					background: sent > 0.5 ? "#16A34A" : "#2563EB",
					transform: `scale(${1 - press * 0.05})`,
					boxShadow: "0 1px 2px rgba(0,0,0,0.12)",
					transition: "background 250ms",
				}}
			>
				{sent > 0.5 ? "Sent to client" : "Send invoice"}
			</div>
		</div>
	</div>
);

export const Webcam = ({
	playing,
	className,
	style,
}: {
	playing: boolean;
	className?: string;
	style?: CSSProperties;
}) => {
	const ref = useRef<HTMLVideoElement | null>(null);
	useVideo(playing, ref);
	const attrs = useVideoAttrs(PRESENTER.poster);
	return (
		<div
			className={classNames("overflow-hidden bg-[#CFC6B8]", className)}
			style={style}
		>
			<video
				ref={ref}
				muted
				loop
				playsInline
				{...attrs}
				className="size-full object-cover object-[50%_30%]"
			>
				<PresenterSources />
			</video>
		</div>
	);
};

export const Cursor = ({
	x,
	y,
	size = 26,
	opacity = 1,
}: {
	x: number;
	y: number;
	size?: number;
	opacity?: number;
}) => {
	const windows = useIsWindowsDemo();
	// Arrow tips: (4, 3.3) in the 17x24 macOS art, (3.3, 3.75) in the 18x25
	// Windows art, so the hotspot lands exactly on (x, y) for either.
	const ratio = windows ? 18 / 25 : 17 / 24;
	const tip = windows
		? { x: 3.3 / 25, y: 3.75 / 25 }
		: { x: 4 / 24, y: 3.3 / 24 };
	return (
		<div
			className="pointer-events-none absolute left-0 top-0 z-30"
			style={{
				width: size * ratio,
				height: size,
				transform: `translate(${x - size * tip.x}px, ${y - size * tip.y}px)`,
				opacity,
				filter: "drop-shadow(0 1px 1.5px rgba(0,0,0,0.45))",
			}}
		>
			{windows ? (
				<WindowsCursor className="block size-full" />
			) : (
				<MacCursor className="block size-full" />
			)}
		</div>
	);
};

export const Ripple = ({
	x,
	y,
	k,
	color = "rgba(37,99,235,0.35)",
}: {
	x: number;
	y: number;
	k: number;
	color?: string;
}) =>
	k <= 0 || k >= 1 ? null : (
		<div
			className="pointer-events-none absolute z-20 rounded-full"
			style={{
				left: x - 22,
				top: y - 22,
				width: 44,
				height: 44,
				background: color,
				transform: `scale(${0.4 + k * 1.1})`,
				opacity: 1 - k,
			}}
		/>
	);

export const WALLPAPERS = {
	sf: "/backgrounds/landing/sf.webp",
	santorini: "/backgrounds/landing/santorini.webp",
	london: "/backgrounds/landing/london.webp",
	miami: "/backgrounds/landing/miami.webp",
	monaco: "/backgrounds/landing/monaco.webp",
	nyc: "/backgrounds/landing/nyc.webp",
	rome: "/backgrounds/landing/rome.webp",
} as const;

export const thumbOf = (src: string) => src.replace(/\.webp$/, "-thumb.webp");

export const Wallpaper = ({
	src,
	opacity = 1,
}: {
	src: string;
	opacity?: number;
}) => (
	<div
		className="absolute inset-0 bg-cover bg-center"
		style={{ backgroundImage: `url(${src})`, opacity }}
	/>
);

export const FrameChip = ({
	children,
	className,
	style,
}: {
	children: ReactNode;
	className?: string;
	style?: CSSProperties;
}) => (
	<div
		className={classNames(
			"absolute z-20 rounded-full bg-[rgba(17,17,17,0.72)] px-3 py-1.5 text-[13px] text-white backdrop-blur-md",
			className,
		)}
		style={style}
	>
		{children}
	</div>
);
