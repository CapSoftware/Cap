import { customerFeedback } from "./marketing/customer-feedback";
import { customerWelcome } from "./marketing/customer-welcome";
import { customerWorkflow } from "./marketing/customer-workflow";
import { formerFeedback } from "./marketing/former-feedback";
import { freePlans } from "./marketing/free-plans";
import { freeRecord } from "./marketing/free-record";
import { freeShare } from "./marketing/free-share";
import { freeWelcome } from "./marketing/free-welcome";
import { teammateHandoff } from "./marketing/teammate-handoff";
import { teammateWelcome } from "./marketing/teammate-welcome";
import type { Journey } from "./types";

export const journeys: Journey[] = [
	{
		key: "free",
		name: "Cap | Independent free-user onboarding",
		audience: "free",
		promotional: true,
		messages: [
			{ ...freeWelcome, delayDays: 0 },
			{
				...freeRecord,
				delayDays: 2,
				onlyIf: { property: "capHasVideo", value: false },
			},
			{
				...freeShare,
				delayDays: 3,
				onlyIf: { property: "capHasSharedVideo", value: false },
			},
			{ ...freePlans, delayDays: 4 },
		],
	},
	{
		key: "customer",
		name: "Cap | Customer onboarding",
		audience: "customer",
		promotional: false,
		messages: [
			{ ...customerWelcome, delayDays: 0 },
			{ ...customerWorkflow, delayDays: 3 },
			{ ...customerFeedback, delayDays: 4 },
		],
	},
	{
		key: "teammate",
		name: "Cap | Teammate onboarding",
		audience: "teammate",
		promotional: false,
		messages: [
			{ ...teammateWelcome, delayDays: 0 },
			{ ...teammateHandoff, delayDays: 3 },
		],
	},
	{
		key: "former",
		name: "Cap | Former customer follow-up",
		audience: "former",
		promotional: true,
		messages: [{ ...formerFeedback, delayDays: 14 }],
	},
];
