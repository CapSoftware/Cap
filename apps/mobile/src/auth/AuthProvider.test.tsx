import React, { type ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext";

type HostProps = {
	children?: ReactNode;
};

const secureStoreMock = vi.hoisted(() => ({
	deleteItemAsync: vi.fn((_key: string) => Promise.resolve()),
	getItemAsync: vi.fn((_key: string) => Promise.resolve(null as string | null)),
	setItemAsync: vi.fn((_key: string, _value: string) => Promise.resolve()),
}));

const apiMock = vi.hoisted(() => ({
	bootstrap: vi.fn(() =>
		Promise.resolve({
			activeOrganizationId: "org_123",
			user: {
				email: "richie@cap.so",
				name: "Richie",
			},
		}),
	),
	getAuthConfig: vi.fn(() =>
		Promise.resolve({
			googleAuthAvailable: true,
			workosAuthAvailable: true,
		}),
	),
}));

vi.mock("react-native", async () => {
	const React = await import("react");

	return {
		View: ({ children }: HostProps) =>
			React.createElement("View", null, children),
	};
});

vi.mock("expo-constants", () => ({
	default: {
		expoConfig: {
			extra: {},
		},
	},
}));

vi.mock("expo-linking", () => ({
	createURL: vi.fn(() => "cap://auth"),
}));

vi.mock("expo-secure-store", () => secureStoreMock);

vi.mock("expo-web-browser", () => ({
	maybeCompleteAuthSession: vi.fn(),
	openAuthSessionAsync: vi.fn(),
}));

vi.mock("@/api/mobile", () => ({
	createMobileApiClient: vi.fn(() => ({
		bootstrap: apiMock.bootstrap,
		getAuthConfig: apiMock.getAuthConfig,
		revokeSession: vi.fn(() => Promise.resolve({ success: true })),
		setActiveOrganization: vi.fn(),
	})),
	createSessionRequestUrl: vi.fn(
		() => "https://cap.so/api/mobile/session/request",
	),
}));

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const flushMicrotasks = async () => {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
};

const states: Array<{
	apiKey: string | null;
	status: string;
	userId: string | null;
}> = [];

const Probe = () => {
	const auth = useAuth();
	states.push({
		apiKey: auth.apiKey,
		status: auth.status,
		userId: auth.userId,
	});
	return null;
};

describe("AuthProvider", () => {
	beforeEach(() => {
		states.length = 0;
		secureStoreMock.deleteItemAsync.mockClear();
		secureStoreMock.getItemAsync.mockReset();
		secureStoreMock.getItemAsync.mockResolvedValue(null);
		secureStoreMock.setItemAsync.mockClear();
		apiMock.bootstrap.mockReset();
		apiMock.bootstrap.mockResolvedValue({
			activeOrganizationId: "org_123",
			user: {
				email: "richie@cap.so",
				name: "Richie",
			},
		});
		apiMock.getAuthConfig.mockReset();
		apiMock.getAuthConfig.mockResolvedValue({
			googleAuthAvailable: true,
			workosAuthAvailable: true,
		});
	});

	it("clears an orphaned stored user id when no API key is stored", async () => {
		secureStoreMock.getItemAsync.mockImplementation((key: string) =>
			Promise.resolve(key === "cap.mobile.userId" ? "user_123" : null),
		);

		await act(async () => {
			TestRenderer.create(
				React.createElement(AuthProvider, null, React.createElement(Probe)),
			);
			await flushMicrotasks();
		});

		expect(states.at(-1)).toMatchObject({
			apiKey: null,
			status: "signedOut",
			userId: null,
		});
		expect(secureStoreMock.deleteItemAsync).toHaveBeenCalledWith(
			"cap.mobile.userId",
		);
	});

	it("clears the stored user id when bootstrapping a stored session fails", async () => {
		secureStoreMock.getItemAsync.mockImplementation((key: string) => {
			if (key === "cap.mobile.apiKey") return Promise.resolve("key_123");
			if (key === "cap.mobile.userId") return Promise.resolve("user_123");
			return Promise.resolve(null);
		});
		apiMock.bootstrap.mockRejectedValueOnce(new Error("Session expired"));

		await act(async () => {
			TestRenderer.create(
				React.createElement(AuthProvider, null, React.createElement(Probe)),
			);
			await flushMicrotasks();
		});

		expect(states.at(-1)).toMatchObject({
			apiKey: null,
			status: "signedOut",
			userId: null,
		});
		expect(secureStoreMock.deleteItemAsync).toHaveBeenCalledWith(
			"cap.mobile.apiKey",
		);
		expect(secureStoreMock.deleteItemAsync).toHaveBeenCalledWith(
			"cap.mobile.userId",
		);
	});
});
