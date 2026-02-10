import { LoadingSpinner } from "@cap/ui";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { type ExtensionMeResponse, fetchExtensionMe } from "@/lib/me";
import { setRpcAuthToken } from "@/lib/rpc";
import { signInViaWeb } from "@/lib/session";
import { getStoredApiKey, setStoredApiKey } from "@/lib/storage";
import { RecorderView } from "./RecorderView";
import { SignInView } from "./SignInView";

type AuthState =
	| { status: "loading" }
	| { status: "signed-out" }
	| { status: "signed-in"; apiKey: string; me: ExtensionMeResponse };

export const App = () => {
	const [state, setState] = useState<AuthState>({ status: "loading" });
	const [isSigningIn, setIsSigningIn] = useState(false);

	useEffect(() => {
		let cancelled = false;

		const load = async () => {
			const apiKey = await getStoredApiKey();
			if (!apiKey) {
				if (!cancelled) setState({ status: "signed-out" });
				return;
			}

			setRpcAuthToken(apiKey);

			try {
				const me = await fetchExtensionMe(apiKey);
				if (!cancelled) setState({ status: "signed-in", apiKey, me });
			} catch {
				setRpcAuthToken(null);
				await setStoredApiKey(null);
				if (!cancelled) setState({ status: "signed-out" });
			}
		};

		void load();

		return () => {
			cancelled = true;
		};
	}, []);

	const handleSignIn = async () => {
		setIsSigningIn(true);
		try {
			const apiKey = await signInViaWeb();
			await setStoredApiKey(apiKey);
			setRpcAuthToken(apiKey);
			const me = await fetchExtensionMe(apiKey);
			setState({ status: "signed-in", apiKey, me });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Sign in failed");
			setState({ status: "signed-out" });
		} finally {
			setIsSigningIn(false);
		}
	};

	const handleSignOut = async () => {
		setRpcAuthToken(null);
		await setStoredApiKey(null);
		setState({ status: "signed-out" });
	};

	const content =
		state.status === "loading" ? (
			<div className="h-full w-full flex items-center justify-center">
				<LoadingSpinner size={18} />
			</div>
		) : state.status === "signed-out" ? (
			<SignInView onSignIn={handleSignIn} isSigningIn={isSigningIn} />
		) : (
			<RecorderView
				me={state.me}
				apiKey={state.apiKey}
				onSignOut={handleSignOut}
			/>
		);

	return <div className="h-full w-full">{content}</div>;
};
