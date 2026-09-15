import { customerUpdate } from "./marketing/customer-update";
import { freeUpdate } from "./marketing/free-update";
import type { Campaign } from "./types";

export const campaignTemplates: Campaign[] = [
	{
		...customerUpdate,
		name: "Cap | Customer product update template",
		audience: "customer",
		promotional: false,
	},
	{
		...freeUpdate,
		name: "Cap | Noncustomer product update template",
		audience: "free",
		promotional: true,
	},
];
