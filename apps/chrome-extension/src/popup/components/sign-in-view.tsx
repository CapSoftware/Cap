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
				{authPending ? "完成登录" : "登录后开始录制"}
			</h1>
			<p className="cap-signin-lede cap-fade-up cap-fade-up-3">
				{authPending
					? "请在 Cap 窗口中完成登录，此面板会自动更新。"
					: "录制标签页、屏幕或摄像头，视频会在录制过程中同步上传。"}
			</p>
			{authPending ? (
				<p className="cap-signin-wait cap-fade-up cap-fade-up-4">
					<svg viewBox="0 0 24 24" aria-hidden="true">
						<circle pathLength={1} cx="12" cy="12" r="9" />
					</svg>
					正在等待 Cap 登录窗口…
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
				{authPending ? "重新打开登录窗口" : "登录 Cap"}
			</button>
			<p
				className={
					authPending
						? "cap-signin-footnote cap-fade-up cap-fade-up-6"
						: "cap-signin-footnote cap-fade-up cap-fade-up-5"
				}
			>
				{authPending
					? "连接成功后窗口会自动关闭。"
					: "停止录制时，分享链接即可使用。"}
			</p>
		</div>
	);
};
