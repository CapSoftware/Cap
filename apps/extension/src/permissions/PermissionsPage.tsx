import {
	CameraIcon,
	CheckCircleIcon,
	MicIcon,
	XCircleIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type PermissionResult = "pending" | "requesting" | "granted" | "denied";

export const PermissionsPage = () => {
	const [cameraStatus, setCameraStatus] = useState<PermissionResult>("pending");
	const [micStatus, setMicStatus] = useState<PermissionResult>("pending");

	const requestPermissions = useCallback(async () => {
		setCameraStatus("requesting");
		setMicStatus("requesting");

		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				video: { width: { ideal: 1280 }, height: { ideal: 720 } },
				audio: true,
			});
			for (const track of stream.getTracks()) {
				track.stop();
			}
			setCameraStatus("granted");
			setMicStatus("granted");
		} catch {
			try {
				const videoStream = await navigator.mediaDevices.getUserMedia({
					video: { width: { ideal: 1280 }, height: { ideal: 720 } },
					audio: false,
				});
				for (const track of videoStream.getTracks()) {
					track.stop();
				}
				setCameraStatus("granted");
			} catch {
				setCameraStatus("denied");
			}

			try {
				const audioStream = await navigator.mediaDevices.getUserMedia({
					audio: true,
					video: false,
				});
				for (const track of audioStream.getTracks()) {
					track.stop();
				}
				setMicStatus("granted");
			} catch {
				setMicStatus("denied");
			}
		}
	}, []);

	useEffect(() => {
		requestPermissions();
	}, [requestPermissions]);

	const allGranted = cameraStatus === "granted" && micStatus === "granted";
	const doneRequesting =
		(cameraStatus === "granted" || cameraStatus === "denied") &&
		(micStatus === "granted" || micStatus === "denied");

	useEffect(() => {
		if (allGranted) {
			const timeout = setTimeout(() => {
				window.close();
			}, 1500);
			return () => clearTimeout(timeout);
		}
	}, [allGranted]);

	const statusIcon = (status: PermissionResult) => {
		if (status === "granted") {
			return <CheckCircleIcon className="size-5 text-green-600" />;
		}
		if (status === "denied") {
			return <XCircleIcon className="size-5 text-red-600" />;
		}
		return (
			<div className="size-5 rounded-full border-2 border-gray-8 border-t-transparent animate-spin" />
		);
	};

	const statusLabel = (status: PermissionResult) => {
		if (status === "granted") return "Granted";
		if (status === "denied") return "Denied";
		if (status === "requesting") return "Requesting...";
		return "Waiting";
	};

	return (
		<div className="flex items-center justify-center min-h-screen bg-[var(--gray-2)]">
			<div className="flex flex-col items-center gap-6 p-8 max-w-sm w-full">
				<div className="flex flex-col items-center gap-2">
					<h1 className="text-lg font-semibold text-[var(--text-primary)]">
						Cap needs permissions
					</h1>
					<p className="text-sm text-gray-11 text-center">
						Allow access to your camera and microphone to record with Cap.
					</p>
				</div>

				<div className="flex flex-col gap-3 w-full">
					<div className="flex items-center gap-3 p-3 rounded-lg border border-gray-3 bg-white">
						<CameraIcon className="size-5 text-gray-11 shrink-0" />
						<span className="flex-1 text-sm font-medium text-[var(--text-primary)]">
							Camera
						</span>
						<div className="flex items-center gap-2">
							<span className="text-xs text-gray-11">
								{statusLabel(cameraStatus)}
							</span>
							{statusIcon(cameraStatus)}
						</div>
					</div>

					<div className="flex items-center gap-3 p-3 rounded-lg border border-gray-3 bg-white">
						<MicIcon className="size-5 text-gray-11 shrink-0" />
						<span className="flex-1 text-sm font-medium text-[var(--text-primary)]">
							Microphone
						</span>
						<div className="flex items-center gap-2">
							<span className="text-xs text-gray-11">
								{statusLabel(micStatus)}
							</span>
							{statusIcon(micStatus)}
						</div>
					</div>
				</div>

				{allGranted && (
					<p className="text-sm text-green-600 text-center">
						Permissions granted! This tab will close automatically...
					</p>
				)}

				{doneRequesting && !allGranted && (
					<div className="flex flex-col items-center gap-3">
						<p className="text-sm text-gray-11 text-center">
							Some permissions were denied. You can update them in your browser
							settings.
						</p>
						<button
							type="button"
							onClick={() => requestPermissions()}
							className="px-4 py-2 text-sm font-medium rounded-lg bg-[var(--primary)] text-white hover:bg-[var(--primary-2)] transition-colors"
						>
							Try again
						</button>
					</div>
				)}

				<button
					type="button"
					onClick={() => window.close()}
					className="text-sm text-gray-11 hover:text-[var(--text-primary)] transition-colors"
				>
					Close this tab
				</button>
			</div>
		</div>
	);
};
