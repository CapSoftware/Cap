"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

const AuthOverlayInner = dynamic(
	() => import("./AuthOverlay").then((m) => m.AuthOverlay),
	{ ssr: false },
);

/**
 * Drop-in for `AuthOverlay` that keeps its chunk (next-auth, the OTP form) off
 * the wire until a signed-out viewer actually hits an auth wall. Latched on
 * first open so closing still plays the dialog's exit animation.
 */
export function AuthOverlay(props: { isOpen: boolean; onClose: () => void }) {
	const [mounted, setMounted] = useState(props.isOpen);

	useEffect(() => {
		if (props.isOpen) setMounted(true);
	}, [props.isOpen]);

	if (!mounted) return null;
	return <AuthOverlayInner {...props} />;
}
