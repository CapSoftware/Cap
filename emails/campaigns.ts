import { customerUpdate } from "./marketing/customer-update";
import { freeUpdate } from "./marketing/free-update";
import type { Campaign } from "./types";

export const campaignTemplates: Campaign[] = [
	{
		...customerUpdate,
		name: "Cap v0.6 launch | Customers",
		audience: "customer",
		promotional: false,
	},
	{
		...freeUpdate,
		name: "Cap v0.6 launch | Noncustomers",
		audience: "free",
		promotional: true,
	},
];
