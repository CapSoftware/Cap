/**
 * The two pointers Cap Desktop actually ships, traced 1:1 from
 * `packages/ui-solid/icons/cursor-macos.svg` and `cursor-windows.svg`.
 *
 * The only change is the shadow: the source files carry it as an SVG filter
 * with a hard-coded id, which would collide wherever two cursors render on
 * the same page, so it is applied in CSS at the use site instead
 * (`drop-shadow(...)`, matching the 1.5px blur at 60% black).
 */

type CursorProps = { className?: string };

export const MacCursor = ({ className }: CursorProps) => (
	<svg aria-hidden="true" className={className} viewBox="0 0 17 24" fill="none">
		<path
			fillRule="evenodd"
			clipRule="evenodd"
			d="M4.501 3.2601L12.884 11.6611C13.937 12.7171 13.19 14.5191 11.699 14.5191L10.475 14.519L11.6908 17.4067C11.9038 17.9127 11.9068 18.4727 11.6998 18.9817C11.4918 19.4917 11.0978 19.8897 10.5898 20.1027C10.3338 20.2097 10.0658 20.2637 9.7918 20.2637C8.9608 20.2637 8.2158 19.7687 7.8938 19.0027L6.616 15.965L5.784 16.7031C4.703 17.6591 3 16.8921 3 15.4481V3.8811C3 3.0971 3.947 2.7051 4.501 3.2601Z"
			fill="white"
		/>
		<path
			fillRule="evenodd"
			clipRule="evenodd"
			d="M4 4.53033C4 4.39933 4.159 4.33333 4.251 4.42633L12.159 12.3513C12.59 12.7833 12.284 13.5203 11.674 13.5203L8.97 13.5188L10.7696 17.7947C10.9966 18.3347 10.7426 18.9557 10.2036 19.1817C9.6626 19.4087 9.0426 19.1557 8.8166 18.6167L6.999 14.2928L5.139 15.9403C4.723 16.3083 4.0811 16.0518 4.007 15.5285L4 15.4273V4.53033Z"
			fill="black"
		/>
	</svg>
);

export const WindowsCursor = ({ className }: CursorProps) => (
	<svg aria-hidden="true" className={className} viewBox="0 0 18 25" fill="none">
		<path
			d="M3.3125 18.3749V3.75391L13.9027 14.3874H8.84609L11.4221 20.5586L8.84609 21.508L6.36552 15.4317L3.3125 18.3749Z"
			fill="white"
			stroke="black"
			strokeWidth="0.622951"
		/>
	</svg>
);

export const CURSOR_RATIO = { macos: 17 / 24, windows: 18 / 25 } as const;

export const PlatformCursor = ({
	platform,
	className,
}: CursorProps & { platform: "macos" | "windows" }) =>
	platform === "windows" ? (
		<WindowsCursor className={className} />
	) : (
		<MacCursor className={className} />
	);
