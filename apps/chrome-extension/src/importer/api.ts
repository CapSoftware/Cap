import { ApiRequestError } from "../shared/api";
import type { ExtensionAuth, ExtensionSettings } from "../shared/types";

export type ImportContext = {
	user: { id: string; email: string };
	organizations: { id: string; name: string; canImport: boolean }[];
	activeOrganizationId: string;
	isPro: boolean;
	defaultPublic: boolean;
	maxRows: number;
};

export type ImportResponse = {
	success: boolean;
	videoId?: string;
	error?: string;
	existing?: boolean;
	uncertain?: boolean;
};

type Connection = { settings: ExtensionSettings; auth: ExtensionAuth };

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const request = async (
	{ settings, auth }: Connection,
	body?: unknown,
): Promise<unknown> => {
	const response = await fetch(
		new URL("/api/extension/import-loom", settings.apiBaseUrl),
		{
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: `Bearer ${auth.authApiKey}`,
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			credentials: "omit",
			redirect: "error",
			cache: "no-store",
			signal: AbortSignal.timeout(body === undefined ? 15_000 : 125_000),
		},
	);
	if (!response.ok) {
		const messages: Record<number, string> = {
			400: "Cap rejected this import. Check the video link, owner and Space.",
			401: "Your Cap session expired. Sign in again to continue.",
			403: "Importing requires a Cap Pro account and an organization admin or owner role.",
			404: "This Cap server does not support the extension importer yet.",
			429: "Too many import requests. Wait a moment before continuing.",
		};
		throw new ApiRequestError(
			response.status,
			messages[response.status] ??
				"Cap could not confirm the request. Check your dashboard before trying again.",
		);
	}
	return response.json();
};

export const fetchImportContext = async (
	connection: Connection,
): Promise<ImportContext> => {
	const data = await request(connection);
	if (
		!isObject(data) ||
		!isObject(data.user) ||
		typeof data.user.id !== "string" ||
		typeof data.user.email !== "string" ||
		!Array.isArray(data.organizations) ||
		!data.organizations.every(
			(org: unknown) =>
				isObject(org) &&
				typeof org.id === "string" &&
				typeof org.name === "string" &&
				typeof org.canImport === "boolean",
		) ||
		typeof data.activeOrganizationId !== "string" ||
		typeof data.isPro !== "boolean" ||
		typeof data.defaultPublic !== "boolean" ||
		typeof data.maxRows !== "number" ||
		!Number.isInteger(data.maxRows) ||
		data.maxRows < 1 ||
		data.maxRows > 500
	) {
		throw new Error(
			"Cap returned an invalid importer response. Try reconnecting.",
		);
	}
	return data as ImportContext;
};

export const importLoomRow = async (
	connection: Connection,
	organizationId: string,
	row: {
		rowNumber: number;
		loomUrl: string;
		userEmail: string;
		spaceName?: string;
	},
): Promise<ImportResponse> => {
	const data = await request(connection, { organizationId, row });
	if (
		!isObject(data) ||
		typeof data.success !== "boolean" ||
		(data.videoId !== undefined && typeof data.videoId !== "string") ||
		(data.error !== undefined && typeof data.error !== "string") ||
		(data.existing !== undefined && typeof data.existing !== "boolean") ||
		(data.uncertain !== undefined && typeof data.uncertain !== "boolean") ||
		(data.success && !data.videoId)
	) {
		throw new Error("Cap did not confirm this import. Check your dashboard.");
	}
	return data as ImportResponse;
};
