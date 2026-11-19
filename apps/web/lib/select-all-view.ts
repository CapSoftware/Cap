export const MAX_SELECT_ALL_ITEMS = 5000;

export type SelectAllView =
	| { type: "personal" }
	| { type: "archived" }
	| { type: "space"; spaceId: string }
	| { type: "organization"; organizationId: string };
