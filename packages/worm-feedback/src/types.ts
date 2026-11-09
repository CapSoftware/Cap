export interface FeedbackContext {
	userId?: string | number;
	orgId?: string | number;
	release?: string | number;
}

export interface PostHogLike {
	get_session_id?: () => string | undefined | null;
	get_session_replay_url?: (options?: {
		withTimestamp?: boolean;
		timestampLookBack?: number;
	}) => string | undefined | null;
}

export interface RouteRule {
	pattern: RegExp;
	replace: string;
}

export interface WormFeedbackConfig {
	server: string;
	siteKey: string;
	getContext?: () => FeedbackContext | Promise<FeedbackContext>;
	posthog?: PostHogLike;
	routeRules?: RouteRule[];
	requestIdHeaders?: string[];
	genericTestids?: string[];
	position?: "bottom-right" | "bottom-left";
	label?: string;
}

export interface ElementDescription {
	tag?: string;
	role?: string | null;
	control?: boolean;
	testid?: string | null;
	region?: string;
	aria?: string | null;
	title?: string | null;
	name?: string | null;
	type?: string;
	label?: string;
	text?: string;
	area?: boolean;
	ctx?: string;
	row?: string;
	on?: boolean;
	editable?: boolean;
	masked?: boolean;
}

export type EvidenceEvent =
	| { t: number; ev: "click"; url: string; el: ElementDescription | null }
	| {
			t: number;
			ev: "console";
			url: string;
			level: "warning" | "error";
			text: string;
	  }
	| { t: number; ev: "pageerror"; url: string; text: string }
	| {
			t: number;
			ev: "http" | "write";
			url: string;
			method: string;
			request: string;
			status: number;
			durationMs: number;
			requestId?: string;
			failure?: string;
	  };

export interface Evidence {
	schemaVersion: 1;
	capturedAt: number;
	route: string;
	viewport: { width: number; height: number; dpr: number };
	userAgent: string;
	language: string;
	timezone?: string;
	context: Record<string, string>;
	posthog?: { sessionId?: string; replayUrl?: string };
	voice?: { mimeType: string; durationMs: number };
	events: EvidenceEvent[];
}

export interface WormFeedback {
	open(): void;
	close(): void;
	destroy(): void;
}
