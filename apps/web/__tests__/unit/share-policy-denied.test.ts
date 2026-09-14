import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { PolicyDeniedView } from "../../app/s/[videoId]/_components/PolicyDeniedView";

describe("PolicyDeniedView", () => {
	it("renders private video sign in link and button with next param", () => {
		const videoId = "vid12345";
		const view = PolicyDeniedView({ videoId });
		expect(isValidElement(view)).toBe(true);

		const children = (view as ReactElement<{ children: ReactElement[] }>).props
			.children;
		const titleElement = children[1];
		const buttonElement = children[3];

		expect(titleElement.props.children).toBe("This video is private");
		expect(buttonElement).toBeDefined();

		const linkChild = buttonElement.props.children;
		expect(linkChild.props.href).toBe("/login?next=%2Fs%2Fvid12345");
	});

	it("renders email restriction login required with next param", () => {
		const videoId = "restricted987";
		const view = PolicyDeniedView({
			videoId,
			reason: "email_restriction_login_required",
		});
		expect(isValidElement(view)).toBe(true);

		const children = (view as ReactElement<{ children: ReactElement[] }>).props
			.children;
		const titleElement = children[1];
		const buttonElement = children[3];

		expect(titleElement.props.children).toBe("This video requires sign-in");
		expect(buttonElement).toBeDefined();

		const linkChild = buttonElement.props.children;
		expect(linkChild.props.href).toBe("/login?next=%2Fs%2Frestricted987");
	});

	it("renders email restriction denied without sign in button", () => {
		const videoId = "restricted987";
		const view = PolicyDeniedView({
			videoId,
			reason: "email_restriction_denied",
		});
		expect(isValidElement(view)).toBe(true);

		const children = (
			view as ReactElement<{ children: (ReactElement | boolean)[] }>
		).props.children;
		const titleElement = children[1] as ReactElement;
		const buttonElement = children[3];

		expect(titleElement.props.children).toBe("Access restricted");
		expect(buttonElement).toBe(false);
	});

	it("falls back to /login when videoId is not provided", () => {
		const view = PolicyDeniedView({});
		const children = (view as ReactElement<{ children: ReactElement[] }>).props
			.children;
		const buttonElement = children[3];
		expect(buttonElement).toBeDefined();
		const linkChild = buttonElement.props.children;
		expect(linkChild.props.href).toBe("/login");
	});
});
