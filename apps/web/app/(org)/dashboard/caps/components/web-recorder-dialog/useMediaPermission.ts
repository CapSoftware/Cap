"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type MediaPermissionKind = "camera" | "microphone";

type MediaPermissionState = PermissionState | "unsupported" | "unknown";

const permissionNameMap: Record<MediaPermissionKind, PermissionName> = {
	camera: "camera",
	microphone: "microphone",
};

const mediaConstraintsMap: Record<MediaPermissionKind, MediaStreamConstraints> =
	{
		camera: {
			video: { width: { ideal: 1280 }, height: { ideal: 720 } },
			audio: false,
		},
		microphone: { audio: true, video: false },
	};

export const useMediaPermission = (
	kind: MediaPermissionKind,
	enabled: boolean,
) => {
	const [state, setState] = useState<MediaPermissionState>("unknown");
	const permissionStatusRef = useRef<PermissionStatus | null>(null);

	const updateState = useCallback((next: MediaPermissionState) => {
		setState((prev) => {
			if (prev === next) return prev;
			return next;
		});
	}, []);

	const refreshPermission = useCallback(async () => {
		if (!enabled) return;
		if (typeof navigator === "undefined" || !navigator.permissions?.query) {
			updateState("unsupported");
			return;
		}

		try {
			const descriptor = {
				name: permissionNameMap[kind],
			} as PermissionDescriptor;

			const permissionStatus = await navigator.permissions.query(descriptor);
			if (permissionStatusRef.current) {
				permissionStatusRef.current.onchange = null;
			}
			permissionStatusRef.current = permissionStatus;

			updateState(permissionStatus.state);

			permissionStatus.onchange = () => {
				updateState(permissionStatus.state);
			};
		} catch (_error) {
			updateState("unsupported");
		}
	}, [enabled, kind, updateState]);

	useEffect(() => {
		if (!enabled) return;
		refreshPermission();

		return () => {
			if (permissionStatusRef.current) {
				permissionStatusRef.current.onchange = null;
			}
			permissionStatusRef.current = null;
		};
	}, [enabled, refreshPermission]);

	const requestPermission = useCallback(async () => {
		if (
			typeof navigator === "undefined" ||
			!navigator.mediaDevices?.getUserMedia
		) {
			updateState("unsupported");
			return false;
		}

		try {
			const stream = await navigator.mediaDevices.getUserMedia(
				mediaConstraintsMap[kind],
			);
			stream.getTracks().forEach((track) => track.stop());
			updateState("granted");
			await refreshPermission();
			return true;
		} catch (error) {
			if (error instanceof DOMException) {
				if (
					error.name === "NotAllowedError" ||
					error.name === "SecurityError"
				) {
					updateState("denied");
				}
			}
			throw error;
		}
	}, [kind, refreshPermission, updateState]);

	return {
		state,
		requestPermission,
	};
};
