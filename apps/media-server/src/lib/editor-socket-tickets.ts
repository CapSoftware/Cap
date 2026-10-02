import { randomBytes } from "node:crypto";
import { getEditorSession, getEditorSessionVideoId } from "./editor-sessions";

const TICKET_TTL_MS = 30_000;
const MAX_TICKETS = 300;

export type EditorSocketScope = "frames" | "audio" | "events" | "commands";

type Ticket = {
	sessionId: string;
	scope: EditorSocketScope;
	origin: string;
	expiresAt: number;
};

const tickets = new Map<string, Ticket>();

export function publicEditorOrigin() {
	const configured = process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN;
	if (!configured)
		throw new Error("Public editor socket origin is unavailable");
	const url = new URL(configured);
	if (
		(url.protocol !== "https:" &&
			!(
				url.protocol === "http:" &&
				["localhost", "127.0.0.1"].includes(url.hostname)
			)) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new Error("Invalid public editor socket origin");
	}
	return url.origin;
}

function publicSocketBase() {
	const url = new URL(publicEditorOrigin());
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.origin;
}

export function createEditorSocketTickets(sessionId: string, origin: string) {
	const page = new URL(origin);
	if (
		(page.protocol !== "https:" &&
			!(
				page.protocol === "http:" &&
				["localhost", "127.0.0.1"].includes(page.hostname)
			)) ||
		page.username ||
		page.password ||
		page.origin !== origin
	) {
		throw new Error("Invalid editor page origin");
	}
	const session = getEditorSession(sessionId);
	const videoId = getEditorSessionVideoId(sessionId);
	if (!session || !videoId) return null;
	if (tickets.size + 4 > MAX_TICKETS) {
		throw new Error("Editor socket ticket capacity is busy");
	}
	const base = publicSocketBase();
	const sockets = Object.fromEntries(
		(["frames", "audio", "events", "commands"] as const).map((scope) => {
			const ticket = randomBytes(32).toString("base64url");
			tickets.set(ticket, {
				sessionId,
				scope,
				origin,
				expiresAt: Date.now() + TICKET_TTL_MS,
			});
			return [
				scope,
				{
					url: `${base}/editor/sessions/${encodeURIComponent(sessionId)}/${scope}`,
					ticket,
				},
			];
		}),
	) as Record<EditorSocketScope, { url: string; ticket: string }>;
	return { videoId, sockets };
}

export function consumeEditorSocketTicket(
	sessionId: string,
	scope: EditorSocketScope,
	origin: string | null,
	protocols: string | null,
) {
	const protocol = protocols
		?.split(",")
		.map((value) => value.trim())
		.find((value) => value.startsWith("cap-editor-ticket."));
	if (!protocol) return null;
	const token = protocol.slice("cap-editor-ticket.".length);
	const ticket = tickets.get(token);
	tickets.delete(token);
	if (
		!ticket ||
		!origin ||
		ticket.expiresAt < Date.now() ||
		ticket.sessionId !== sessionId ||
		ticket.scope !== scope ||
		ticket.origin !== origin ||
		!protocols?.split(",").some((value) => value.trim() === "cap-editor-v1")
	) {
		return null;
	}
	return getEditorSession(sessionId);
}

const sweep = setInterval(() => {
	for (const [token, ticket] of tickets) {
		if (ticket.expiresAt < Date.now()) tickets.delete(token);
	}
}, 30_000);
sweep.unref();
