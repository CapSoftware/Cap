import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CapBrand, DoodleBoilFilter } from "../shared/cap-brand";
import { toCameraDevices } from "../shared/devices";
import { mountPageNav } from "../shared/page-nav";
import { rememberCameraSelection } from "../shared/preferences";
import { sendServiceWorkerMessage } from "../shared/runtime";
import {
	loadSettings,
	saveSettings,
	updateMediaAccessState,
} from "../shared/storage";
import type { CameraDevice, ExtensionSettings } from "../shared/types";
import { DEFAULT_CAMERA_DEVICE_ID } from "../shared/types";
import "./styles.css";

mountPageNav("camera");

type Status = "idle" | "requesting" | "ready" | "error";

const headlines: Record<Status, { title: string; lede: string }> = {
	idle: {
		title: "Camera & microphone access",
		lede: "Allow access once so Cap can show your camera preview and record your voice.",
	},
	requesting: {
		title: "Waiting for Chrome",
		lede: "Click Allow in the browser prompt up by the address bar.",
	},
	ready: {
		title: "You're all set",
		lede: "Pick the camera Cap should use. It's remembered for every recording.",
	},
	error: {
		title: "Cap needs access",
		lede: "Allow access once so Cap can show your camera preview and record your voice.",
	},
};

const stopStream = (stream: MediaStream) => {
	for (const track of stream.getTracks()) {
		track.stop();
	}
};

const getCameraErrorMessage = (error: unknown) => {
	if (!(error instanceof Error)) return "Camera unavailable";
	if (
		error.name === "NotAllowedError" ||
		error.message.toLowerCase().includes("permission")
	) {
		return "Chrome did not grant camera access. Click Allow in the browser prompt.";
	}
	if (error.name === "NotFoundError") return "No camera was found.";
	if (error.name === "NotReadableError") return "Camera is already in use.";
	return error.message || "Camera unavailable";
};

const getPreferredDeviceId = (
	settings: ExtensionSettings,
	devices: CameraDevice[],
) => {
	const selectedDeviceStillExists = devices.some(
		(device) => device.deviceId === settings.webcam.deviceId,
	);
	if (
		settings.webcam.deviceId &&
		settings.webcam.deviceId !== DEFAULT_CAMERA_DEVICE_ID &&
		selectedDeviceStillExists
	) {
		return settings.webcam.deviceId;
	}
	return devices[0]?.deviceId ?? DEFAULT_CAMERA_DEVICE_ID;
};

function App() {
	const [settings, setSettings] = useState<ExtensionSettings | null>(null);
	const [devices, setDevices] = useState<CameraDevice[]>([]);
	const [selectedDeviceId, setSelectedDeviceId] = useState<string>(
		DEFAULT_CAMERA_DEVICE_ID,
	);
	const [status, setStatus] = useState<Status>("idle");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let disposed = false;

		Promise.all([
			loadSettings(),
			sendServiceWorkerMessage({
				target: "service-worker",
				type: "get-camera-devices",
			}).catch(() => null),
		]).then(([nextSettings, response]) => {
			if (disposed) return;
			setSettings(nextSettings);
			const cachedDevices = response?.ok ? (response.cameraDevices ?? []) : [];
			setDevices(cachedDevices);
			setSelectedDeviceId(
				nextSettings.webcam.deviceId ??
					cachedDevices[0]?.deviceId ??
					DEFAULT_CAMERA_DEVICE_ID,
			);
			if (cachedDevices.length > 0) {
				void updateMediaAccessState({ camera: true }).catch(() => undefined);
				setStatus("ready");
			}
		});

		return () => {
			disposed = true;
		};
	}, []);

	const saveCameraSelection = async (
		nextSettings: ExtensionSettings,
		nextDevices: CameraDevice[],
		deviceId: string,
	) => {
		const settingsToSave = rememberCameraSelection(
			nextSettings,
			deviceId,
			nextDevices,
		);
		setSettings(settingsToSave);
		setSelectedDeviceId(deviceId);
		await saveSettings(settingsToSave);
		await sendServiceWorkerMessage({
			target: "service-worker",
			type: "camera-devices-updated",
			devices: nextDevices,
		}).catch(() => undefined);
		await sendServiceWorkerMessage({
			target: "service-worker",
			type: "settings-updated",
			settings: settingsToSave,
		}).catch(() => undefined);
	};

	const requestAccess = async () => {
		if (!settings) return;
		if (!navigator.mediaDevices?.getUserMedia) {
			setStatus("error");
			setError("Camera access is not available in this browser.");
			return;
		}

		setStatus("requesting");
		setError(null);

		try {
			// Request camera and microphone together so the extension origin gets
			// both grants from one prompt; retry camera-only when no mic exists.
			const stream = await navigator.mediaDevices
				.getUserMedia({ video: true, audio: true })
				.catch((err: unknown) => {
					if (err instanceof DOMException && err.name === "NotFoundError") {
						return navigator.mediaDevices.getUserMedia({
							video: true,
							audio: false,
						});
					}
					throw err;
				});
			const cameraGranted = stream.getVideoTracks().length > 0;
			const microphoneGranted = stream.getAudioTracks().length > 0;
			stopStream(stream);
			await updateMediaAccessState({
				...(cameraGranted ? { camera: true } : {}),
				...(microphoneGranted ? { microphone: true } : {}),
			});

			const nextDevices = toCameraDevices(
				await navigator.mediaDevices.enumerateDevices(),
			);
			const deviceId = getPreferredDeviceId(settings, nextDevices);
			setDevices(nextDevices);
			await saveCameraSelection(settings, nextDevices, deviceId);
			setStatus("ready");
		} catch (err) {
			setStatus("error");
			setError(getCameraErrorMessage(err));
		}
	};

	const handleDeviceChange = async (deviceId: string) => {
		if (!settings) return;
		await saveCameraSelection(settings, devices, deviceId);
	};

	const { title, lede } = headlines[status];

	return (
		<>
			<main className="stage" data-mode={status}>
				<header className="brand">
					<CapBrand />
				</header>
				<svg className="doodle" viewBox="0 0 120 104" aria-hidden="true">
					<defs>
						<DoodleBoilFilter />
					</defs>
					<g className="doodle-boil">
						<path
							className="doodle-stroke camera-body"
							pathLength={1}
							d="M 30 36 L 44 36 L 50 26 L 70 26 L 76 36 L 90 36 Q 98 36 98 44 L 98 80 Q 98 88 90 88 L 30 88 Q 22 88 22 80 L 22 44 Q 22 36 30 36 Z"
						/>
						<circle
							className="doodle-stroke camera-lens"
							pathLength={1}
							cx="60"
							cy="62"
							r="15"
						/>
						<circle className="lens-dot" cx="60" cy="62" r="6" />
						<circle className="flash-dot" cx="88" cy="46" r="2.5" />
						<path
							className="spark spark-1"
							d="M 16 16 L 16 22 M 16 30 L 16 36 M 6 26 L 12 26 M 20 26 L 26 26"
						/>
						<path
							className="spark spark-2"
							d="M 102 6 L 102 12 M 102 20 L 102 26 M 92 16 L 98 16 M 106 16 L 112 16"
						/>
						<path
							className="spark spark-3"
							d="M 108 58 L 108 63 M 108 69 L 108 74 M 100 66 L 105 66 M 111 66 L 116 66"
						/>
					</g>
				</svg>
				<h1>{title}</h1>
				<p className="lede">{lede}</p>

				{status === "ready" && devices.length > 0 && (
					<div className="card device-card">
						<label className="field">
							<span>Camera Cap should use</span>
							<select
								value={selectedDeviceId}
								onChange={(event) =>
									void handleDeviceChange(event.currentTarget.value)
								}
							>
								{devices.map((device) => (
									<option key={device.deviceId} value={device.deviceId}>
										{device.label}
									</option>
								))}
							</select>
						</label>
						<p className="paper-pill success">
							<svg
								className="check-mini"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<path
									className="check-mini-path"
									pathLength={1}
									d="M 4 13 L 9.5 18 L 20 6"
								/>
							</svg>
							Camera preview is enabled.
						</p>
					</div>
				)}

				{status === "error" && error && (
					<p className="paper-pill error">{error}</p>
				)}

				<div className="cta-row">
					<button
						type="button"
						className="cta"
						disabled={status === "requesting" || !settings}
						onClick={() => void requestAccess()}
					>
						{status === "requesting"
							? "Waiting for Chrome…"
							: status === "ready"
								? "Re-check access"
								: "Allow camera & microphone"}
					</button>
					{status === "ready" && (
						<button
							type="button"
							className="cta ghost"
							onClick={() => void requestAccess()}
						>
							Refresh list
						</button>
					)}
				</div>
				<svg className="wait-squiggle" viewBox="0 0 240 26" aria-hidden="true">
					<path
						className="wait-squiggle-path"
						pathLength={100}
						d="M 6 14 q 6 -7 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0"
					/>
				</svg>
			</main>
			<p className="footnote">
				Chrome remembers this. Cap only uses your camera while you record.
			</p>
		</>
	);
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
