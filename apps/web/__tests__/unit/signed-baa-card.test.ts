// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentProps, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	confirmSignedBaaPayment,
	getSignedBaaStatus,
	purchaseSignedBaa,
	type SignedBaaStatus,
	signPaidBaa,
} from "@/actions/organization/signed-baa";
import { SignedBaaCard } from "@/app/(org)/dashboard/settings/organization/components/SignedBaaCard";

const mocks = vi.hoisted(() => ({
	organizationId: "org-1",
	searchParams: new URLSearchParams(),
	refresh: vi.fn(),
	replace: vi.fn(),
	success: vi.fn(),
	error: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: mocks.refresh, replace: mocks.replace }),
	useSearchParams: () => mocks.searchParams,
}));

vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		activeOrganization: { organization: { id: mocks.organizationId } },
		user: { name: "Jane", lastName: "Smith", email: "jane@example.com" },
	}),
}));

vi.mock("@/actions/organization/signed-baa", () => ({
	getSignedBaaStatus: vi.fn(),
	confirmSignedBaaPayment: vi.fn(),
	purchaseSignedBaa: vi.fn(),
	signPaidBaa: vi.fn(),
}));

vi.mock("sonner", () => ({
	toast: { success: mocks.success, error: mocks.error },
}));

vi.mock("@fortawesome/react-fontawesome", () => ({
	FontAwesomeIcon: () => null,
}));

vi.mock("@cap/ui", async () => {
	const { createElement } = await import("react");
	const container = ({ children }: { children?: ReactNode }) =>
		createElement("div", null, children);
	return {
		Card: container,
		CardDescription: container,
		CardHeader: container,
		CardTitle: container,
		DialogContent: container,
		DialogHeader: container,
		DialogTitle: container,
		Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
			open ? createElement("div", { role: "dialog" }, children) : null,
		Button: ({ children, disabled, onClick, type }: ComponentProps<"button">) =>
			createElement("button", { disabled, onClick, type }, children),
		Input: (props: ComponentProps<"input">) => createElement("input", props),
	};
});

vi.mock(
	"@/app/(org)/dashboard/settings/organization/components/SignaturePad",
	async () => {
		const { createElement } = await import("react");
		return {
			SignaturePad: ({
				onChange,
				disabled,
			}: {
				onChange: (signature: string | null) => void;
				disabled: boolean;
			}) =>
				createElement(
					"button",
					{
						type: "button",
						disabled,
						onClick: () => onChange("data:image/png;base64,fresh-signature"),
					},
					"Draw signature",
				),
		};
	},
);

const details = {
	entityName: "Acme Health LLC",
	entityType: "LLC",
	entityAddress: "123 Main Street",
	signerName: "Jane Smith",
	signerTitle: "Director",
	noticesEmail: "legal@example.com",
};

const createStatus = (
	overrides: Partial<SignedBaaStatus> = {},
): SignedBaaStatus => ({
	status: "none",
	signedAt: null,
	entityName: null,
	emailSentAt: null,
	canPurchase: true,
	details: null,
	...overrides,
});

const paidStatus = createStatus({
	status: "paid",
	details,
	canPurchase: false,
});
const activeStatus = createStatus({
	status: "active",
	signedAt: "2026-08-26T12:00:00.000Z",
	entityName: details.entityName,
});

const actEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

const deferred = <T>() => {
	let resolve: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve: (value: T) => resolve(value) };
};

const button = (text: string) =>
	Array.from(container.querySelectorAll("button")).find(
		(element) => element.textContent === text,
	);

const click = async (text: string) => {
	const target = button(text);
	expect(target).toBeDefined();
	await act(async () => target?.click());
};

const render = async () => {
	await act(async () => {
		root.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(SignedBaaCard),
			),
		);
	});
};

const waitFor = async (assertion: () => void) => {
	await vi.waitFor(async () => {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		assertion();
	});
};

const redirect = () => {
	window.history.replaceState(
		window.history.state,
		"",
		"/dashboard/settings/organization/billing?baaRedirect=true&session_id=cs_paid",
	);
	mocks.searchParams = new URLSearchParams(window.location.search);
};

describe("Signed BAA payment and signing", () => {
	beforeAll(() => {
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	});

	beforeEach(() => {
		mocks.organizationId = "org-1";
		mocks.searchParams = new URLSearchParams();
		window.history.replaceState(
			window.history.state,
			"",
			"/dashboard/settings/organization/billing",
		);
		mocks.replace.mockImplementation((href: string) => {
			window.history.replaceState(window.history.state, "", href);
			mocks.searchParams = new URLSearchParams(window.location.search);
		});
		vi.mocked(getSignedBaaStatus).mockReset().mockResolvedValue(createStatus());
		vi.mocked(confirmSignedBaaPayment)
			.mockReset()
			.mockResolvedValue(paidStatus);
		vi.mocked(purchaseSignedBaa)
			.mockReset()
			.mockResolvedValue({ success: true, emailSent: true });
		vi.mocked(signPaidBaa)
			.mockReset()
			.mockResolvedValue({ success: true, emailSent: true });
		queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		queryClient.clear();
		document.body.replaceChildren();
	});

	afterAll(() => {
		delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	});

	it("verifies the checkout before showing paid and opening a fresh signature form", async () => {
		redirect();
		const confirmation = deferred<SignedBaaStatus>();
		vi.mocked(confirmSignedBaaPayment).mockReturnValue(confirmation.promise);
		await render();

		expect(container.textContent).toContain("Confirming your BAA payment");
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(button("Get Signed BAA")).toBeUndefined();
		expect(confirmSignedBaaPayment).toHaveBeenCalledWith("org-1", "cs_paid");

		vi.mocked(getSignedBaaStatus).mockResolvedValue(paidStatus);
		await act(async () => confirmation.resolve(paidStatus));
		await waitFor(() => {
			expect(container.textContent).toContain("Paid — awaiting signature");
			expect(container.querySelector('[role="dialog"]')).not.toBeNull();
		});

		expect(queryClient.getQueryData(["signed-baa", "org-1"])).toEqual(
			paidStatus,
		);
		expect(getSignedBaaStatus).toHaveBeenCalledTimes(2);
		expect(container.querySelector("input")?.value).toBe(details.entityName);
		expect(button("Sign BAA")?.disabled).toBe(true);
		expect(container.textContent).toContain("no additional charge");
		expect(container.textContent).not.toContain("authorize Cap to charge");
		expect(button("Sign & pay $99/mo")).toBeUndefined();

		await click("Cancel");
		await act(async () => {
			await queryClient.invalidateQueries({
				queryKey: ["signed-baa", "org-1"],
			});
		});
		await render();
		expect(container.querySelector('[role="dialog"]')).toBeNull();
	});

	it("consumes a verified redirect without losing other URL state or blocking the next organization", async () => {
		window.history.replaceState(
			window.history.state,
			"",
			"/dashboard/settings/organization/billing?tab=invoices&baaRedirect=true&session_id=cs_paid&tag=one&tag=two#signed-baa",
		);
		mocks.searchParams = new URLSearchParams(window.location.search);
		vi.mocked(getSignedBaaStatus).mockResolvedValue(paidStatus);
		await render();
		await waitFor(() => expect(button("Sign BAA")).toBeDefined());

		expect(mocks.replace).toHaveBeenCalledOnce();
		expect(mocks.replace).toHaveBeenCalledWith(
			"/dashboard/settings/organization/billing?tab=invoices&tag=one&tag=two#signed-baa",
			{ scroll: false },
		);
		expect(window.location.search).not.toContain("session_id");
		expect(window.location.search).not.toContain("baaRedirect");
		await click("Cancel");
		mocks.organizationId = "org-2";
		vi.mocked(getSignedBaaStatus).mockResolvedValue(createStatus());
		await render();
		await waitFor(() => expect(button("Get Signed BAA")?.disabled).toBe(false));

		expect(confirmSignedBaaPayment).toHaveBeenCalledOnce();
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.querySelector('[role="dialog"]')).toBeNull();
	});

	it("keeps failed confirmation blocked and lets the customer retry without paying", async () => {
		redirect();
		vi.mocked(getSignedBaaStatus).mockResolvedValue(paidStatus);
		vi.mocked(confirmSignedBaaPayment).mockRejectedValueOnce(
			new Error("The payment is still pending."),
		);
		await render();
		await waitFor(() => {
			expect(container.textContent).toContain("The payment is still pending.");
		});

		expect(container.textContent).toContain("Do not pay again");
		expect(button("Get Signed BAA")).toBeUndefined();
		expect(button("Complete and sign BAA")).toBeUndefined();
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(mocks.replace).not.toHaveBeenCalled();
		vi.mocked(getSignedBaaStatus).mockResolvedValue(paidStatus);
		await click("Retry payment confirmation");
		await waitFor(() => expect(button("Sign BAA")).toBeDefined());
		expect(confirmSignedBaaPayment).toHaveBeenCalledTimes(2);
		expect(purchaseSignedBaa).not.toHaveBeenCalled();
	});

	it("does not overwrite verified payment with an earlier in-flight status lookup", async () => {
		redirect();
		const oldStatus = deferred<SignedBaaStatus>();
		vi.mocked(getSignedBaaStatus)
			.mockReturnValueOnce(oldStatus.promise)
			.mockResolvedValue(paidStatus);
		await render();
		await waitFor(() => expect(button("Sign BAA")).toBeDefined());
		await act(async () => oldStatus.resolve(createStatus()));

		expect(queryClient.getQueryData(["signed-baa", "org-1"])).toEqual(
			paidStatus,
		);
		expect(button("Get Signed BAA")).toBeUndefined();
		expect(button("Sign BAA")).toBeDefined();
	});

	it("does not treat an untrusted redirect flag without a session as payment", async () => {
		mocks.searchParams = new URLSearchParams("baaRedirect=true");
		await render();

		expect(container.textContent).toContain("confirmation link is incomplete");
		expect(container.textContent).not.toContain("Paid — awaiting signature");
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(button("Get Signed BAA")).toBeUndefined();
		expect(confirmSignedBaaPayment).not.toHaveBeenCalled();
		expect(purchaseSignedBaa).not.toHaveBeenCalled();
	});

	it("does not open the purchase form when verification returns an unpaid status", async () => {
		redirect();
		vi.mocked(confirmSignedBaaPayment).mockResolvedValue(createStatus());
		await render();
		await waitFor(() => {
			expect(container.textContent).toContain("payment could not be confirmed");
		});

		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(button("Get Signed BAA")).toBeUndefined();
		expect(purchaseSignedBaa).not.toHaveBeenCalled();
	});

	it("signs a paid BAA with a fresh signature without invoking purchase", async () => {
		vi.mocked(getSignedBaaStatus).mockResolvedValue(paidStatus);
		const signing = deferred<{
			success: true;
			emailSent: boolean;
		}>();
		vi.mocked(signPaidBaa).mockReturnValue(signing.promise);
		await render();
		await waitFor(() => expect(button("Complete and sign BAA")).toBeDefined());
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		await click("Complete and sign BAA");
		expect(button("Sign BAA")?.disabled).toBe(true);
		await click("Draw signature");
		expect(button("Sign BAA")?.disabled).toBe(false);
		await click("Sign BAA");
		await waitFor(() => expect(button("Processing...")?.disabled).toBe(true));

		expect(signPaidBaa).toHaveBeenCalledWith("org-1", {
			...details,
			signatureDataUrl: "data:image/png;base64,fresh-signature",
		});
		expect(purchaseSignedBaa).not.toHaveBeenCalled();
		expect(button("Complete and sign BAA")?.disabled).toBe(true);
		expect(button("Draw signature")?.disabled).toBe(true);

		vi.mocked(getSignedBaaStatus).mockResolvedValue(activeStatus);
		await act(async () => signing.resolve({ success: true, emailSent: true }));
		await waitFor(() => expect(button("Download signed copy")).toBeDefined());
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(mocks.refresh).toHaveBeenCalledOnce();
	});

	it("preserves ordinary purchase and its payment authorization", async () => {
		mocks.searchParams = new URLSearchParams("session_id=cs_other_product");
		vi.mocked(getSignedBaaStatus).mockResolvedValue(createStatus({ details }));
		await render();
		await waitFor(() => expect(button("Get Signed BAA")?.disabled).toBe(false));
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		await click("Get Signed BAA");
		expect(container.textContent).toContain("authorize Cap to charge");
		await click("Draw signature");
		await click("Sign & pay $99/mo");
		await waitFor(() => expect(purchaseSignedBaa).toHaveBeenCalledOnce());
		expect(purchaseSignedBaa).toHaveBeenCalledWith("org-1", {
			...details,
			signatureDataUrl: "data:image/png;base64,fresh-signature",
		});
		expect(confirmSignedBaaPayment).not.toHaveBeenCalled();
		expect(signPaidBaa).not.toHaveBeenCalled();
	});

	it("refreshes payment status after a failed purchase instead of offering another charge", async () => {
		vi.mocked(getSignedBaaStatus).mockResolvedValue(createStatus({ details }));
		vi.mocked(purchaseSignedBaa).mockRejectedValue(
			new Error(
				"The payment succeeded but the agreement could not be completed.",
			),
		);
		await render();
		await waitFor(() => expect(button("Get Signed BAA")?.disabled).toBe(false));
		await click("Get Signed BAA");
		await click("Draw signature");
		vi.mocked(getSignedBaaStatus).mockResolvedValue(paidStatus);
		await click("Sign & pay $99/mo");
		await waitFor(() => expect(button("Sign BAA")).toBeDefined());

		expect(container.textContent).toContain("Paid — awaiting signature");
		expect(button("Sign & pay $99/mo")).toBeUndefined();
		expect(button("Sign BAA")?.disabled).toBe(true);
		expect(mocks.error).toHaveBeenCalledWith(
			"The payment succeeded but the agreement could not be completed.",
		);
		expect(purchaseSignedBaa).toHaveBeenCalledOnce();
	});

	it("preserves the active agreement download without opening another signing form", async () => {
		redirect();
		vi.mocked(getSignedBaaStatus).mockResolvedValue(activeStatus);
		vi.mocked(confirmSignedBaaPayment).mockResolvedValue(activeStatus);
		await render();
		await waitFor(() => expect(button("Download signed copy")).toBeDefined());

		expect(container.textContent).toContain("Active");
		expect(container.textContent).toContain(details.entityName);
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(button("Get Signed BAA")).toBeUndefined();
		expect(button("Complete and sign BAA")).toBeUndefined();
		expect(mocks.replace).toHaveBeenCalledWith(
			"/dashboard/settings/organization/billing",
			{ scroll: false },
		);
	});

	it("keeps a processing redirect until the agreement is ready for its signature", async () => {
		redirect();
		const processing = createStatus({ status: "processing" });
		vi.mocked(getSignedBaaStatus).mockResolvedValue(processing);
		vi.mocked(confirmSignedBaaPayment).mockResolvedValue(processing);
		await render();
		await waitFor(() => {
			expect(container.textContent).toContain("Your BAA is processing");
		});
		expect(mocks.replace).not.toHaveBeenCalled();
		expect(window.location.search).toContain("session_id=cs_paid");

		await act(async () => {
			queryClient.setQueryData(["signed-baa", "org-1"], paidStatus);
		});
		await waitFor(() => expect(button("Sign BAA")).toBeDefined());
		expect(mocks.replace).toHaveBeenCalledWith(
			"/dashboard/settings/organization/billing",
			{ scroll: false },
		);
		expect(window.location.search).toBe("");
	});

	it("blocks duplicate actions while the server is processing a BAA", async () => {
		vi.mocked(getSignedBaaStatus).mockResolvedValue(
			createStatus({ status: "processing" }),
		);
		await render();
		await waitFor(() => {
			expect(container.textContent).toContain("Your BAA is processing");
		});
		expect(button("Get Signed BAA")).toBeUndefined();
		expect(button("Complete and sign BAA")).toBeUndefined();
	});

	it("never applies an old organization's confirmation to the newly selected organization", async () => {
		redirect();
		const previousConfirmation = deferred<SignedBaaStatus>();
		vi.mocked(confirmSignedBaaPayment)
			.mockReturnValueOnce(previousConfirmation.promise)
			.mockRejectedValueOnce(
				new Error("Payment belongs to another organization."),
			);
		await render();
		mocks.organizationId = "org-2";
		await render();
		await waitFor(() => {
			expect(container.textContent).toContain(
				"Payment belongs to another organization.",
			);
		});

		await act(async () => previousConfirmation.resolve(paidStatus));
		await waitFor(() => {
			expect(queryClient.getQueryData(["signed-baa", "org-1"])).toEqual(
				paidStatus,
			);
		});
		expect(queryClient.getQueryData(["signed-baa", "org-2"])).toEqual(
			createStatus(),
		);
		expect(container.textContent).not.toContain("Paid — awaiting signature");
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(confirmSignedBaaPayment).toHaveBeenNthCalledWith(
			2,
			"org-2",
			"cs_paid",
		);
	});

	it("clears company details and the signature when the organization changes", async () => {
		vi.mocked(getSignedBaaStatus).mockResolvedValue(paidStatus);
		await render();
		await waitFor(() => expect(button("Complete and sign BAA")).toBeDefined());
		await click("Complete and sign BAA");
		await click("Draw signature");
		expect(button("Sign BAA")?.disabled).toBe(false);

		mocks.organizationId = "org-2";
		vi.mocked(getSignedBaaStatus).mockResolvedValue(createStatus());
		await render();
		await waitFor(() => expect(button("Get Signed BAA")?.disabled).toBe(false));
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		await click("Get Signed BAA");
		expect(container.querySelector("input")?.value).toBe("");
		expect(button("Sign & pay $99/mo")?.disabled).toBe(true);
		expect(purchaseSignedBaa).not.toHaveBeenCalled();
	});
});
