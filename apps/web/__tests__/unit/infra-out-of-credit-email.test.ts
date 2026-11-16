import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sendEmail: vi.fn() }));

vi.mock("@cap/database", () => {
	const chain = {
		select: () => chain,
		from: () => chain,
		innerJoin: () => chain,
		where: () => chain,
		limit: async () => [
			{ appId: "app-1", appName: "Acme", email: "owner@example.com" },
		],
	};
	return { db: () => chain };
});
vi.mock("@cap/database/emails/config", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		CAP_INFRA_BILLING_EMAILS: true,
		WEB_URL: "https://cap.so",
	}),
}));
vi.mock("@/lib/infra-access", () => ({ canUseInfra: () => true }));

import { InfraOutOfCredit } from "@cap/database/emails/infra-out-of-credit";
import { sendInfraOutOfCreditEmail } from "@/lib/infra-billing-emails";

const shortSince = new Date("2026-11-13T06:41:00Z");
const send = () =>
	sendInfraOutOfCreditEmail({
		accountId: "account-1",
		shortSince,
		pausesAt: new Date(shortSince.getTime() + 7 * 24 * 60 * 60 * 1000),
	});

beforeEach(() => {
	mocks.sendEmail.mockReset();
});

describe("the out-of-credit email", () => {
	it("reports a send only when the email service accepted it", async () => {
		mocks.sendEmail.mockResolvedValueOnce({ data: { id: "e-1" }, error: null });
		expect(await send()).toBe(true);

		mocks.sendEmail.mockResolvedValueOnce({
			data: null,
			error: { name: "validation_error", message: "rejected" },
		});
		expect(await send()).toBe(false);

		mocks.sendEmail.mockResolvedValueOnce(undefined);
		expect(await send()).toBe(false);
	});

	it("uses one dedupe key per account and shortfall day, and pauses seven days after the shortfall", async () => {
		mocks.sendEmail.mockResolvedValue({ data: { id: "e-1" }, error: null });
		await send();

		expect(mocks.sendEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				idempotencyKey: "infra-out-of-credit-account-1-2026-11-13",
			}),
		);
		const html = renderToStaticMarkup(mocks.sendEmail.mock.calls[0]?.[0].react);
		expect(html).toContain("November 20");
	});

	it("words the shortfall for any storage charge", () => {
		const html = renderToStaticMarkup(
			InfraOutOfCredit({
				email: "owner@example.com",
				appName: "Acme",
				billingUrl: "https://cap.so/billing",
				pausesOn: "November 20",
			}),
		);
		const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

		expect(text).toContain(
			"A storage charge for Acme was more than its Cap Infra balance, so the balance is now zero.",
		);
		expect(text).toContain(
			"Adding credits brings the app straight back. What it could not pay is not charged afterwards.",
		);
		expect(text).not.toMatch(/\btoday\b|\bdaily\b|\bdays it could not\b/i);
		expect(html).not.toContain(String.fromCodePoint(0x2014));
	});
});
