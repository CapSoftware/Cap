import "server-only";

import { discordConnection } from "./discord";

const HANDLERS: Record<string, (request: Request) => Promise<Response>> = {
	discord: discordConnection,
};

export function firstPartyConnectionHandler(appId: string) {
	return HANDLERS[appId] ?? null;
}
