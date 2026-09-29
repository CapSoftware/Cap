import assert from "node:assert/strict";
import { test } from "node:test";
import { campaignFilter, campaignTemplates } from "./program";

test("campaigns without campaign conditions clear the campaign filter", () => {
	assert.equal(campaignFilter(), null);
	assert.equal(campaignFilter([]), null);
});

test("the case-study invite only reaches accounts created before its cutoff", () => {
	const template = campaignTemplates.find(
		(campaign) => campaign.id === "customer-case-study",
	);
	assert.deepEqual(campaignFilter(template?.campaignConditions), {
		match: "all",
		conditions: [
			{
				type: "property",
				key: "capSignupAt",
				operator: "before",
				value: "2026-08-30T00:00:00.000Z",
			},
		],
	});
});
