import { describe, expect, it } from "vitest";
import { infraWebhookLocks } from "@/lib/infra-webhook-console";

const idle = { adding: false, creating: false, secretShown: false };

describe("webhook console locks", () => {
	it("allows every action when nothing is open", () => {
		expect(infraWebhookLocks(idle)).toEqual({
			canAdd: true,
			canRotate: true,
			canDelete: true,
		});
	});

	it("blocks rotate and delete while an add is in flight, so its secret cannot be replaced", () => {
		expect(
			infraWebhookLocks({ ...idle, adding: true, creating: true }),
		).toEqual({ canAdd: false, canRotate: false, canDelete: false });
	});

	it("blocks rotate while the add form is open", () => {
		expect(infraWebhookLocks({ ...idle, adding: true })).toMatchObject({
			canAdd: false,
			canRotate: false,
			canDelete: true,
		});
	});

	it("blocks add and rotate until a shown secret is dismissed", () => {
		expect(infraWebhookLocks({ ...idle, secretShown: true })).toEqual({
			canAdd: false,
			canRotate: false,
			canDelete: true,
		});
	});

	it("never lets a second secret start while one is shown or on its way", () => {
		for (const adding of [false, true]) {
			for (const creating of [false, true]) {
				for (const secretShown of [false, true]) {
					const locks = infraWebhookLocks({ adding, creating, secretShown });
					const secretBusy = adding || creating || secretShown;
					expect(locks.canAdd || locks.canRotate).toBe(!secretBusy);
				}
			}
		}
	});
});
