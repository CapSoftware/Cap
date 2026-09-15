import { customerFeedback } from "./marketing/customer-feedback";
import { customerWelcome } from "./marketing/customer-welcome";
import { customerWorkflow } from "./marketing/customer-workflow";
import { formerFeedback } from "./marketing/former-feedback";
import { freePlans } from "./marketing/free-plans";
import { freeRecord } from "./marketing/free-record";
import { freeShare } from "./marketing/free-share";
import { freeV2Ai } from "./marketing/free-v2-ai";
import { freeV2Help } from "./marketing/free-v2-help";
import { freeV2Plans } from "./marketing/free-v2-plans";
import { freeV2Record } from "./marketing/free-v2-record";
import { freeV2Share } from "./marketing/free-v2-share";
import { freeV2Welcome } from "./marketing/free-v2-welcome";
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
		key: "free-v2",
		name: "Cap | Free activation and Pro conversion v2",
		audience: "free",
		promotional: true,
		messages: [
			{ ...freeV2Welcome, delayDays: 0 },
			{
				...freeV2Record,
				delayDays: 1,
				onlyIf: { property: "capNeedsRecordingHelp", value: true },
			},
			{
				...freeV2Plans,
				delayDays: 2,
				onlyIf: { property: "capReadyForPro", value: true },
			},
			{
				...freeV2Share,
				delayDays: 5,
				onlyIf: { property: "capNeedsSharingHelp", value: true },
			},
			{
				...freeV2Ai,
				delayDays: 2,
				onlyIf: { property: "capReadyForPro", value: true },
			},
			{
				...freeV2Help,
				delayDays: 2,
				onlyIf: { property: "capNeedsRecordingHelp", value: true },
			},
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
