import Constants from "expo-constants";
import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	createMobileApiClient,
	createSessionRequestUrl,
	type MobileApiClient,
	MobileApiError,
	type MobileAuthConfigResponse,
	type MobileBootstrapResponse,
} from "@/api/mobile";
import { requireAuthRedirectSession } from "./session";

WebBrowser.maybeCompleteAuthSession();

const sessionKey = "cap.mobile.apiKey";
const userIdKey = "cap.mobile.userId";
const secureStoreOptions: SecureStore.SecureStoreOptions = {
	keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

type AuthState = {
	status: "loading" | "signedOut" | "signedIn";
	apiKey: string | null;
	userId: string | null;
	authConfig: MobileAuthConfigResponse;
	bootstrap: MobileBootstrapResponse | null;
	client: MobileApiClient;
	requestEmailCode: (email: string) => Promise<void>;
	verifyEmailCode: (email: string, code: string) => Promise<void>;
	signInWithApple: () => Promise<void>;
	signInWithGoogle: () => Promise<void>;
	signInWithSso: (organizationId: string) => Promise<void>;
	signOut: () => Promise<void>;
	refresh: () => Promise<void>;
	setActiveOrganization: (organizationId: string) => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);
const fallbackAuthConfig: MobileAuthConfigResponse = {
	appleAuthAvailable: false,
	googleAuthAvailable: true,
	workosAuthAvailable: true,
};

const getExtraString = (key: string, fallback: string) => {
	const extra = Constants.expoConfig?.extra;
	if (!extra || typeof extra !== "object") return fallback;
	const value = (extra as Record<string, unknown>)[key];
	return typeof value === "string" ? value : fallback;
};

export const apiBaseUrl = getExtraString("apiBaseUrl", "https://cap.so");

export function AuthProvider({ children }: { children: ReactNode }) {
	const [apiKey, setApiKey] = useState<string | null>(null);
	const [userId, setUserId] = useState<string | null>(null);
	const [authConfig, setAuthConfig] =
		useState<MobileAuthConfigResponse>(fallbackAuthConfig);
	const [bootstrap, setBootstrap] = useState<MobileBootstrapResponse | null>(
		null,
	);
	const [loading, setLoading] = useState(true);
	const sessionRevision = useRef(0);
	const bootstrapRevision = useRef(0);
	const refreshSequence = useRef({ started: 0, applied: 0 });
	const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const clearBootstrapRetry = useCallback(() => {
		if (retryTimer.current !== null) {
			clearTimeout(retryTimer.current);
			retryTimer.current = null;
		}
	}, []);

	const client = useMemo(
		() =>
			createMobileApiClient({
				baseUrl: apiBaseUrl,
				getToken: () => apiKey,
			}),
		[apiKey],
	);
	const publicClient = useMemo(
		() =>
			createMobileApiClient({
				baseUrl: apiBaseUrl,
				getToken: () => null,
			}),
		[],
	);

	const refresh = useCallback(async () => {
		const revision = sessionRevision.current;
		const requestRevision = bootstrapRevision.current;
		const sequence = ++refreshSequence.current.started;
		try {
			const response = await client.bootstrap();
			if (
				revision !== sessionRevision.current ||
				requestRevision !== bootstrapRevision.current ||
				sequence < refreshSequence.current.applied
			)
				return;
			refreshSequence.current.applied = sequence;
			clearBootstrapRetry();
			setBootstrap(response);
		} catch (error) {
			if (
				revision === sessionRevision.current &&
				requestRevision === bootstrapRevision.current &&
				sequence >= refreshSequence.current.applied
			)
				throw error;
		}
	}, [client, clearBootstrapRetry]);

	useEffect(() => {
		let active = true;
		const load = async () => {
			try {
				const [storedKey, storedUserId, nextAuthConfig] = await Promise.all([
					SecureStore.getItemAsync(sessionKey),
					SecureStore.getItemAsync(userIdKey),
					publicClient.getAuthConfig().catch(() => fallbackAuthConfig),
				]);
				if (!active) return;
				setApiKey(storedKey);
				setUserId(storedKey ? storedUserId : null);
				setAuthConfig(nextAuthConfig);
				if (!storedKey && storedUserId) {
					SecureStore.deleteItemAsync(userIdKey).catch(() => {});
				}
			} finally {
				if (active) setLoading(false);
			}
		};
		load();
		return () => {
			active = false;
		};
	}, [publicClient]);

	useEffect(() => {
		if (!apiKey) {
			setUserId(null);
			setBootstrap(null);
			return;
		}

		const revision = sessionRevision.current;
		let cancelled = false;
		let retryDelayMs = 2_000;
		const attemptBootstrap = () => {
			retryTimer.current = null;
			const requestRevision = bootstrapRevision.current;
			const sequence = refreshSequence.current.started + 1;
			void refresh().catch((error: unknown) => {
				if (
					cancelled ||
					revision !== sessionRevision.current ||
					requestRevision !== bootstrapRevision.current ||
					sequence < refreshSequence.current.applied
				)
					return;
				if (error instanceof MobileApiError && error.status === 401) {
					sessionRevision.current += 1;
					setApiKey(null);
					setUserId(null);
					setBootstrap(null);
					SecureStore.deleteItemAsync(sessionKey).catch(() => {});
					SecureStore.deleteItemAsync(userIdKey).catch(() => {});
					return;
				}
				retryTimer.current = setTimeout(attemptBootstrap, retryDelayMs);
				retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
			});
		};
		attemptBootstrap();
		return () => {
			cancelled = true;
			clearBootstrapRetry();
		};
	}, [apiKey, refresh, clearBootstrapRetry]);

	const storeSession = useCallback(
		async (session: { apiKey: string; userId: string | null }) => {
			sessionRevision.current += 1;
			await SecureStore.setItemAsync(
				sessionKey,
				session.apiKey,
				secureStoreOptions,
			);
			if (session.userId) {
				await SecureStore.setItemAsync(
					userIdKey,
					session.userId,
					secureStoreOptions,
				);
			} else {
				await SecureStore.deleteItemAsync(userIdKey);
			}
			setApiKey(session.apiKey);
			setUserId(session.userId);
		},
		[],
	);

	const requestEmailCode = useCallback(
		async (email: string) => {
			await client.requestEmailCode(email);
		},
		[client],
	);

	const verifyEmailCode = useCallback(
		async (email: string, code: string) => {
			const session = await client.verifyEmailCode({ email, code });
			await storeSession({
				apiKey: session.apiKey,
				userId: session.userId,
			});
		},
		[client, storeSession],
	);

	const signInWithProvider = useCallback(
		async (provider: "apple" | "google") => {
			const redirectUri = Linking.createURL("auth");
			const result = await WebBrowser.openAuthSessionAsync(
				createSessionRequestUrl(apiBaseUrl, redirectUri, provider),
				redirectUri,
			);
			if (result.type !== "success") return;

			await storeSession(requireAuthRedirectSession(result.url));
		},
		[storeSession],
	);

	const signInWithApple = useCallback(
		() => signInWithProvider("apple"),
		[signInWithProvider],
	);

	const signInWithGoogle = useCallback(
		() => signInWithProvider("google"),
		[signInWithProvider],
	);

	const signInWithSso = useCallback(
		async (organizationId: string) => {
			const redirectUri = Linking.createURL("auth");
			const result = await WebBrowser.openAuthSessionAsync(
				createSessionRequestUrl(
					apiBaseUrl,
					redirectUri,
					"workos",
					organizationId,
				),
				redirectUri,
			);
			if (result.type !== "success") return;

			await storeSession(requireAuthRedirectSession(result.url));
		},
		[storeSession],
	);

	const signOut = useCallback(async () => {
		sessionRevision.current += 1;
		if (apiKey) {
			await client.revokeSession().catch(() => {});
		}
		await Promise.all([
			SecureStore.deleteItemAsync(sessionKey),
			SecureStore.deleteItemAsync(userIdKey),
		]);
		sessionRevision.current += 1;
		setApiKey(null);
		setUserId(null);
		setBootstrap(null);
	}, [apiKey, client]);

	const setActiveOrganization = useCallback(
		async (organizationId: string) => {
			const revision = sessionRevision.current;
			const nextBootstrap = await client.setActiveOrganization(organizationId);
			if (revision === sessionRevision.current) {
				bootstrapRevision.current += 1;
				clearBootstrapRetry();
				setBootstrap(nextBootstrap);
			}
		},
		[client, clearBootstrapRetry],
	);

	const value = useMemo<AuthState>(
		() => ({
			status: loading ? "loading" : apiKey ? "signedIn" : "signedOut",
			apiKey,
			userId,
			authConfig,
			bootstrap,
			client,
			requestEmailCode,
			verifyEmailCode,
			signInWithApple,
			signInWithGoogle,
			signInWithSso,
			signOut,
			refresh,
			setActiveOrganization,
		}),
		[
			loading,
			apiKey,
			userId,
			authConfig,
			bootstrap,
			client,
			requestEmailCode,
			verifyEmailCode,
			signInWithApple,
			signInWithGoogle,
			signInWithSso,
			signOut,
			refresh,
			setActiveOrganization,
		],
	);

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => {
	const value = useContext(AuthContext);
	if (!value) throw new Error("useAuth must be used inside AuthProvider");
	return value;
};
