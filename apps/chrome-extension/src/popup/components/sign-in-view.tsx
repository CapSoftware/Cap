import { type CSSProperties, useId } from "react";
import { CapBrand, DoodleBoilFilter } from "../../shared/cap-brand";

interface SignInViewProps {
	authPending: boolean;
	busy: boolean;
	onSignIn: () => void;
}

export const SignInView = ({
	authPending,
	busy,
	onSignIn,
}: SignInViewProps) => {
	const boilId = useId();
	return (
		<div className="cap-signin">
			<CapBrand className="cap-signin-brand cap-fade-up" />
			<svg
				className="cap-signin-doodle cap-fade-up cap-fade-up-1"
				viewBox="0 0 120 104"
				aria-hidden="true"
			>
				<defs>
					<DoodleBoilFilter id={boilId} />
				</defs>
				<g
					className="cap-signin-boil"
					style={{ "--cap-signin-boil": `url(#${boilId})` } as CSSProperties}
				>
					<circle
						className="cap-signin-stroke cap-signin-ring"
						pathLength={1}
						cx="60"
						cy="52"
						r="30"
					/>
					<circle className="cap-signin-dot" cx="60" cy="52" r="11" />
					<path
						className="cap-signin-spark is-1"
						d="M 18 22 L 18 28 M 18 36 L 18 42 M 8 32 L 14 32 M 22 32 L 28 32"
					/>
					<path
						className="cap-signin-spark is-2"
						d="M 100 10 L 100 16 M 100 24 L 100 30 M 90 20 L 96 20 M 104 20 L 110 20"
					/>
					<path
						className="cap-signin-spark is-3"
						d="M 102 64 L 102 69 M 102 75 L 102 80 M 94 72 L 99 72 M 105 72 L 110 72"
					/>
				</g>
			</svg>
			<h1 className="cap-fade-up cap-fade-up-2">
				{authPending ? "Finish signing in" : "Sign in to record"}
			</h1>
			<p className="cap-signin-lede cap-fade-up cap-fade-up-3">
				{authPending
					? "Complete sign-in in the Cap window. This panel updates automatically."
					: "Record your tab, screen or camera. Your video uploads while you record."}
			</p>
			{authPending ? (
				<p className="cap-signin-wait cap-fade-up cap-fade-up-4">
					<svg viewBox="0 0 24 24" aria-hidden="true">
						<circle pathLength={1} cx="12" cy="12" r="9" />
					</svg>
					Waiting for the Cap sign-in window…
				</p>
			) : null}
			<button
				type="button"
				className={
					authPending
						? "cap-paper-cta is-ghost cap-fade-up cap-fade-up-5"
						: "cap-paper-cta cap-fade-up cap-fade-up-4"
				}
				disabled={busy}
				onClick={onSignIn}
			>
				{authPending ? "Open the sign-in window again" : "Sign in to Cap"}
			</button>
			<p
				className={
					authPending
						? "cap-signin-footnote cap-fade-up cap-fade-up-6"
						: "cap-signin-footnote cap-fade-up cap-fade-up-5"
				}
			>
				{authPending
					? "The window closes by itself once it connects."
					: "Your share link is ready the moment you stop."}
			</p>
		</div>
	);
};
