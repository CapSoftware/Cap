import { condition } from "./audiences";
import { customerCaseStudy } from "./marketing/customer-case-study";
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
	{
		...customerCaseStudy,
		name: "Case study and logo wall invite | Cap Pro multi-seat org owners",
		audience: "customer",
		promotional: false,
		audienceConditions: [
			condition("capPlanName", "Cap Pro"),
			condition("capTeammate", false),
			condition("capMultiSeatOwner", true),
		],
	},
];
