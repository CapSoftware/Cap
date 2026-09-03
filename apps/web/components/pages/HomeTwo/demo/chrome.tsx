"use client";

import { classNames } from "@cap/utils/helpers";

export const TrafficLights = ({
	size = 12,
	minimize = true,
	className,
}: {
	size?: number;
	minimize?: boolean;
	className?: string;
}) => (
	<div className={classNames("flex items-center gap-2", className)}>
		{["#FF5F57", ...(minimize ? ["#FEBC2E"] : []), "#28C840"].map((color) => (
			<span
				key={color}
				className="rounded-full"
				style={{ width: size, height: size, background: color }}
			/>
		))}
	</div>
);

const MinimizeGlyph = () => (
	<svg aria-hidden="true" width="10" height="1" viewBox="0 0 10 1" fill="none">
		<path
			d="M0.498047 1.00098C0.429688 1.00098 0.364583 0.987956 0.302734 0.961914C0.244141 0.935872 0.192057 0.900065 0.146484 0.854492C0.100911 0.808919 0.0651042 0.756836 0.0390625 0.698242C0.0130208 0.636393 0 0.571289 0 0.50293C0 0.43457 0.0130208 0.371094 0.0390625 0.3125C0.0651042 0.250651 0.100911 0.19694 0.146484 0.151367C0.192057 0.102539 0.244141 0.0651042 0.302734 0.0390625C0.364583 0.0130208 0.429688 0 0.498047 0H9.50195C9.57031 0 9.63379 0.0130208 9.69238 0.0390625C9.75423 0.0651042 9.80794 0.102539 9.85352 0.151367C9.89909 0.19694 9.9349 0.250651 9.96094 0.3125C9.98698 0.371094 10 0.43457 10 0.50293C10 0.571289 9.98698 0.636393 9.96094 0.698242C9.9349 0.756836 9.89909 0.808919 9.85352 0.854492C9.80794 0.900065 9.75423 0.935872 9.69238 0.961914C9.63379 0.987956 9.57031 1.00098 9.50195 1.00098H0.498047Z"
			fill="currentColor"
		/>
	</svg>
);

const MaximizeGlyph = () => (
	<svg
		aria-hidden="true"
		width="10"
		height="10"
		viewBox="0 0 10 10"
		fill="none"
	>
		<path
			d="M1.47461 10.001C1.2793 10.001 1.09212 9.96191 0.913086 9.88379C0.734049 9.80241 0.576172 9.69499 0.439453 9.56152C0.30599 9.4248 0.198568 9.26693 0.117188 9.08789C0.0390625 8.90885 0 8.72168 0 8.52637V1.47559C0 1.28027 0.0390625 1.0931 0.117188 0.914062C0.198568 0.735026 0.30599 0.578776 0.439453 0.445312C0.576172 0.308594 0.734049 0.201172 0.913086 0.123047C1.09212 0.0416667 1.2793 0.000976562 1.47461 0.000976562H8.52539C8.7207 0.000976562 8.90788 0.0416667 9.08691 0.123047C9.26595 0.201172 9.4222 0.308594 9.55566 0.445312C9.69238 0.578776 9.7998 0.735026 9.87793 0.914062C9.95931 1.0931 10 1.28027 10 1.47559V8.52637C10 8.72168 9.95931 8.90885 9.87793 9.08789C9.7998 9.26693 9.69238 9.4248 9.55566 9.56152C9.4222 9.69499 9.26595 9.80241 9.08691 9.88379C8.90788 9.96191 8.7207 10.001 8.52539 10.001H1.47461ZM8.50098 9C8.56934 9 8.63281 8.98698 8.69141 8.96094C8.75326 8.9349 8.80697 8.89909 8.85254 8.85352C8.89811 8.80794 8.93392 8.75586 8.95996 8.69727C8.986 8.63542 8.99902 8.57031 8.99902 8.50195V1.5C8.99902 1.43164 8.986 1.36816 8.95996 1.30957C8.93392 1.24772 8.89811 1.19401 8.85254 1.14844C8.80697 1.10286 8.75326 1.06706 8.69141 1.04102C8.63281 1.01497 8.56934 1.00195 8.50098 1.00195H1.49902C1.43066 1.00195 1.36556 1.01497 1.30371 1.04102C1.24512 1.06706 1.19303 1.10286 1.14746 1.14844C1.10189 1.19401 1.06608 1.24772 1.04004 1.30957C1.014 1.36816 1.00098 1.43164 1.00098 1.5V8.50195C1.00098 8.57031 1.014 8.63542 1.04004 8.69727C1.06608 8.75586 1.10189 8.80794 1.14746 8.85352C1.19303 8.89909 1.24512 8.9349 1.30371 8.96094C1.36556 8.98698 1.43066 9 1.49902 9H8.50098Z"
			fill="currentColor"
		/>
	</svg>
);

const CloseGlyph = () => (
	<svg
		aria-hidden="true"
		width="10"
		height="10"
		viewBox="0 0 10 10"
		fill="none"
	>
		<path
			d="M5 5.70898L0.854492 9.85449C0.756836 9.95215 0.639648 10.001 0.50293 10.001C0.359701 10.001 0.239258 9.95378 0.141602 9.85938C0.0472005 9.76172 0 9.64128 0 9.49805C0 9.36133 0.0488281 9.24414 0.146484 9.14648L4.29199 5.00098L0.146484 0.855469C0.0488281 0.757812 0 0.638997 0 0.499023C0 0.430664 0.0130208 0.36556 0.0390625 0.303711C0.0651042 0.241862 0.100911 0.189779 0.146484 0.147461C0.192057 0.101888 0.245768 0.0660807 0.307617 0.0400391C0.369466 0.0139974 0.43457 0.000976562 0.50293 0.000976562C0.639648 0.000976562 0.756836 0.0498047 0.854492 0.147461L5 4.29297L9.14551 0.147461C9.24316 0.0498047 9.36198 0.000976562 9.50195 0.000976562C9.57031 0.000976562 9.63379 0.0139974 9.69238 0.0400391C9.75423 0.0660807 9.80794 0.101888 9.85352 0.147461C9.89909 0.193034 9.9349 0.246745 9.96094 0.308594C9.98698 0.367188 10 0.430664 10 0.499023C10 0.638997 9.95117 0.757812 9.85352 0.855469L5.70801 5.00098L9.85352 9.14648C9.95117 9.24414 10 9.36133 10 9.49805C10 9.56641 9.98698 9.63151 9.96094 9.69336C9.9349 9.75521 9.89909 9.80892 9.85352 9.85449C9.8112 9.90007 9.75911 9.93587 9.69727 9.96191C9.63542 9.98796 9.57031 10.001 9.50195 10.001C9.36198 10.001 9.24316 9.95215 9.14551 9.85449L5 5.70898Z"
			fill="currentColor"
		/>
	</svg>
);

export const WindowsCaptionControls = ({
	light,
	className,
}: {
	light?: boolean;
	className?: string;
}) => {
	const cell =
		"flex w-[46px] shrink-0 items-center justify-center self-stretch transition-colors duration-150";
	return (
		<div
			aria-hidden="true"
			className={classNames("flex items-stretch self-stretch", className)}
			style={{ color: light ? "rgba(255,255,255,0.9)" : "rgba(0,0,0,0.9)" }}
		>
			<span
				className={classNames(
					cell,
					light ? "hover:bg-white/10" : "hover:bg-black/[0.05]",
				)}
			>
				<MinimizeGlyph />
			</span>
			<span
				className={classNames(
					cell,
					light ? "hover:bg-white/10" : "hover:bg-black/[0.05]",
				)}
			>
				<MaximizeGlyph />
			</span>
			<span className={classNames(cell, "hover:bg-[#c42b1c] hover:text-white")}>
				<CloseGlyph />
			</span>
		</div>
	);
};

export const OsSwitchButton = ({
	children,
	label,
	tooltip,
	side = "below",
	align = "center",
	className,
	onClick,
}: {
	children: React.ReactNode;
	label: string;
	tooltip: string;
	side?: "below" | "above";
	/** "left" keeps the bubble on screen when the button hugs the corner. */
	align?: "center" | "left";
	className?: string;
	onClick: () => void;
}) => (
	<button
		type="button"
		aria-label={label}
		onClick={(event) => {
			event.stopPropagation();
			onClick();
		}}
		className={classNames(
			"group relative flex cursor-pointer items-center justify-center transition-colors duration-150",
			className,
		)}
	>
		{children}
		<span
			className={classNames(
				"pointer-events-none absolute z-50 whitespace-nowrap rounded-[8px] px-2.5 py-1.5 text-[12px] font-medium text-white opacity-0 shadow-[0_10px_28px_-8px_rgba(9,12,20,0.6)] transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100",
				side === "below" ? "top-[calc(100%+8px)]" : "bottom-[calc(100%+10px)]",
				align === "left" ? "left-0" : "left-1/2 -translate-x-1/2",
			)}
			style={{ background: "#202020" }}
		>
			{tooltip}
		</span>
	</button>
);
