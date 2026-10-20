"use client";

/**
 * Mic mute toggle for the camera and screen recorder cards. A labeled pill,
 * not an icon: the mic glyph already appears on the device pill right above,
 * and two identical mics reading differently was genuinely confusing. Red
 * carries the live-mic association — tinted while the mic is on ("Mute"),
 * solid while it's off ("Unmute", the state that deserves attention).
 */
export function MicMuteButton({
	muted,
	onToggle,
	shape,
}: {
	muted: boolean;
	onToggle: () => void;
	shape: "square" | "round";
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-label={muted ? "Unmute microphone" : "Mute microphone"}
			aria-pressed={muted}
			className={`flex items-center justify-center text-xs font-medium transition-colors ${
				shape === "round" ? "h-8 rounded-full px-3" : "h-7 rounded-lg px-2.5"
			} ${
				muted
					? "bg-red-500 text-white hover:bg-red-600"
					: "bg-red-50 text-red-600 ring-1 ring-red-200 hover:bg-red-100"
			}`}
		>
			{muted ? "Unmute" : "Mute"}
		</button>
	);
}
