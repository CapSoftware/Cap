import type { CapKind } from "./cap-kind";

export const MAX_SELECT_ALL_ITEMS = 5000;

export type SelectAllView =
	| { type: "personal"; kind?: CapKind }
	| { type: "archived" }
	| { type: "space"; spaceId: string }
	| { type: "organization"; organizationId: string };
