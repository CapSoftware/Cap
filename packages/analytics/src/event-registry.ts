import type { AnalyticsStringFormat } from "./privacy";

export type ProductEventDelivery = "critical" | "best_effort";
export type ProductEventAuthority = "client" | "server" | "both";
export type ProductEventPlatform =
	| "web"
	| "desktop"
	| "mobile"
	| "cli"
	| "server";

type EventPropertyRule =
	| {
			type: "string";
			required?: true;
			nullable?: true;
			values: readonly string[];
	  }
	| {
			type: "string";
			required?: true;
			nullable?: true;
			format: AnalyticsStringFormat;
	  }
	| {
			type: "number";
			required?: true;
			nullable?: true;
	  }
	| {
			type: "boolean";
			required?: true;
			nullable?: true;
	  };

interface EventDefinition {
	version: number;
	delivery: ProductEventDelivery;
	authority: ProductEventAuthority;
	platforms: readonly ProductEventPlatform[];
	semantic: string;
	properties: Record<string, EventPropertyRule>;
}

const bestEffortClient = {
	version: 1,
	delivery: "best_effort",
	authority: "client",
} as const;

const criticalServer = {
	version: 1,
	delivery: "critical",
	authority: "server",
} as const;

const optionalAttributionProperties = {
	first_touch_source: { type: "string", format: "attribution" },
	first_touch_medium: { type: "string", format: "attribution" },
	first_touch_campaign: { type: "string", format: "attribution" },
	first_touch_content: { type: "string", format: "attribution" },
	first_touch_term: { type: "string", format: "attribution" },
	first_touch_gclid: { type: "string", format: "identifier" },
	first_touch_fbclid: { type: "string", format: "identifier" },
	session_touch_source: { type: "string", format: "attribution" },
	session_touch_medium: { type: "string", format: "attribution" },
	session_touch_campaign: { type: "string", format: "attribution" },
	session_touch_content: { type: "string", format: "attribution" },
	session_touch_term: { type: "string", format: "attribution" },
	session_touch_gclid: { type: "string", format: "identifier" },
	session_touch_fbclid: { type: "string", format: "identifier" },
	last_touch_source: { type: "string", format: "attribution" },
	last_touch_medium: { type: "string", format: "attribution" },
	last_touch_campaign: { type: "string", format: "attribution" },
	last_touch_content: { type: "string", format: "attribution" },
	last_touch_term: { type: "string", format: "attribution" },
	last_touch_gclid: { type: "string", format: "identifier" },
	last_touch_fbclid: { type: "string", format: "identifier" },
} as const satisfies Record<string, EventPropertyRule>;

export const EVENT_REGISTRY = {
	page_view: {
		...bestEffortClient,
		platforms: ["web"],
		semantic:
			"A permitted browser route became the active document or SPA location. Reloads count as another view; synthetic, preview, internal, and known bot traffic is excluded before decision queries.",
		properties: {
			...optionalAttributionProperties,
			hostname: { type: "string", required: true, format: "hostname" },
			is_session_entry: { type: "boolean", required: true },
			session_started_at: {
				type: "string",
				required: true,
				format: "timestamp",
			},
		},
	},
	page_engagement: {
		...bestEffortClient,
		platforms: ["web"],
		semantic:
			"A bounded summary of foreground engagement for one page view, emitted on route change, hide, or page exit.",
		properties: {
			page_view_id: { type: "string", required: true, format: "identifier" },
			session_started_at: {
				type: "string",
				required: true,
				format: "timestamp",
			},
			engaged_ms: { type: "number", required: true },
			max_scroll_depth: { type: "number", required: true },
		},
	},
	download_cta_clicked: {
		...bestEffortClient,
		platforms: ["web"],
		semantic: "A visitor activated a Cap download call to action.",
		properties: {
			source_page: { type: "string", required: true, format: "category" },
			cta_location: { type: "string", required: true, format: "category" },
			target: { type: "string", format: "category" },
			detected_platform: { type: "string", format: "category" },
			is_intel: { type: "boolean" },
		},
	},
	pricing_cta_clicked: {
		...bestEffortClient,
		platforms: ["web"],
		semantic: "A visitor activated a pricing or plan-selection call to action.",
		properties: {
			source_page: { type: "string", required: true, format: "category" },
			cta_location: { type: "string", format: "category" },
			plan_name: { type: "string", format: "category" },
			authenticated: { type: "boolean" },
			is_pro: { type: "boolean" },
			cta_action: { type: "string", format: "category" },
			target_billing_period: {
				type: "string",
				nullable: true,
				format: "category",
			},
		},
	},
	cli_install_command_copied: {
		...bestEffortClient,
		platforms: ["web"],
		semantic: "A visitor copied the published CLI installation command.",
		properties: {
			source_page: { type: "string", required: true, format: "category" },
			detected_platform: {
				type: "string",
				required: true,
				format: "category",
			},
		},
	},
	auth_started: {
		...bestEffortClient,
		platforms: ["web"],
		semantic: "A visitor deliberately began an authentication attempt.",
		properties: {
			method: {
				type: "string",
				required: true,
				values: ["apple", "email", "google"],
			},
			is_signup: { type: "boolean", required: true },
			auth_surface: {
				type: "string",
				required: true,
				values: ["login", "signup", "share_overlay"],
			},
		},
	},
	auth_email_sent: {
		...bestEffortClient,
		platforms: ["web"],
		semantic: "The authentication provider accepted an email-link request.",
		properties: {
			method: { type: "string", required: true, values: ["email"] },
			is_signup: { type: "boolean", required: true },
			auth_surface: {
				type: "string",
				required: true,
				values: ["login", "signup", "share_overlay"],
			},
		},
	},
	user_signed_up: {
		...criticalServer,
		platforms: ["web"],
		semantic:
			"The authoritative users table contains a newly created account within the signup tracking window.",
		properties: {},
	},
	identity_linked: {
		...criticalServer,
		platforms: ["server"],
		semantic:
			"A successfully authenticated user was linked to the first-party anonymous browser identity present at authentication. Decision metrics use user_id; this event preserves acquisition stitching without changing authoritative account facts.",
		properties: {},
	},
	user_signed_in: {
		version: 1,
		delivery: "critical",
		authority: "both",
		platforms: ["web", "desktop", "mobile"],
		semantic:
			"A client persisted a valid authenticated session, or the web authentication provider completed a successful sign-in callback.",
		properties: {},
	},
	user_signed_out: {
		...bestEffortClient,
		platforms: ["desktop", "mobile"],
		semantic: "A native client deliberately cleared its authenticated session.",
		properties: {},
	},
	recording_started: {
		version: 1,
		delivery: "critical",
		authority: "client",
		platforms: ["desktop", "mobile"],
		semantic:
			"The recorder successfully crossed its start boundary and began producing a recording.",
		properties: {
			mode: { type: "string", required: true, format: "category" },
			target_kind: { type: "string", required: true, format: "category" },
			has_camera: { type: "boolean", required: true },
			has_mic: { type: "boolean", required: true },
			has_system_audio: { type: "boolean", required: true },
			target_fps: { type: "number", required: true },
			target_width: { type: "number", required: true },
			target_height: { type: "number", required: true },
			fragmented: { type: "boolean", required: true },
			custom_cursor_capture: { type: "boolean", required: true },
		},
	},
	recording_start_failed: {
		version: 1,
		delivery: "critical",
		authority: "client",
		platforms: ["desktop", "mobile"],
		semantic:
			"A deliberate recording attempt failed before the recorder crossed its started boundary; the stable event ID is retained across delivery retries.",
		properties: {
			mode: { type: "string", required: true, format: "category" },
			failure_class: { type: "string", required: true, format: "category" },
		},
	},
	recording_completed: {
		version: 1,
		delivery: "critical",
		authority: "client",
		platforms: ["desktop", "mobile"],
		semantic:
			"A started recording reached a terminal success, degraded, or failed state.",
		properties: {
			mode: { type: "string", required: true, format: "category" },
			status: { type: "string", required: true, format: "category" },
			duration_secs: { type: "number", required: true },
			segment_count: { type: "number", required: true },
			track_failure_count: { type: "number", required: true },
			error_class: { type: "string", format: "category" },
			video_frames_captured: { type: "number" },
			video_frames_dropped: { type: "number" },
			drop_rate_pct: { type: "number" },
			capture_stalls_count: { type: "number" },
			capture_stalls_max_ms: { type: "number" },
			mixer_stalls_count: { type: "number" },
			mixer_stalls_max_ms: { type: "number" },
			audio_gaps_count: { type: "number" },
			audio_gaps_total_ms: { type: "number" },
			queue_saturation_count: { type: "number" },
			queue_max_depth: { type: "number" },
			queue_capacity: { type: "number" },
			frame_drop_count: { type: "number" },
			frame_drop_rate_high_count: { type: "number" },
			source_restarts_count: { type: "number" },
			muxer_crash_count: { type: "number" },
			audio_degraded_count: { type: "number" },
			dropped_mic_messages: { type: "number" },
		},
	},
	multipart_upload_complete: {
		version: 1,
		delivery: "critical",
		authority: "client",
		platforms: ["desktop", "mobile"],
		semantic:
			"A recording upload completed and the server acknowledged every part.",
		properties: {
			duration: { type: "number", required: true },
			length: { type: "number", required: true },
			size: { type: "number", required: true },
		},
	},
	multipart_upload_failed: {
		version: 1,
		delivery: "critical",
		authority: "client",
		platforms: ["desktop", "mobile"],
		semantic:
			"A recording upload reached a terminal failure after its recovery policy.",
		properties: {
			duration: { type: "number", required: true },
			failure_class: {
				type: "string",
				required: true,
				format: "category",
			},
		},
	},
	recording_recovery_failed: {
		version: 1,
		delivery: "critical",
		authority: "client",
		platforms: ["desktop"],
		semantic:
			"A bounded recording recovery attempt reached a terminal failure.",
		properties: {
			trigger: { type: "string", required: true, format: "category" },
			failure_class: {
				type: "string",
				required: true,
				format: "category",
			},
		},
	},
	upload_completed: {
		...criticalServer,
		platforms: ["cli", "server"],
		semantic:
			"The authoritative upload state accepted a complete single-part object for processing; platform is the persisted initiating surface.",
		properties: {},
	},
	upload_failed: {
		...criticalServer,
		platforms: ["cli", "server"],
		semantic:
			"The authoritative upload state permanently rejected a single-part upload before processing, using a bounded failure class.",
		properties: {
			failure_class: { type: "string", required: true, format: "category" },
		},
	},
	analytics_delivery_loss: {
		version: 1,
		delivery: "critical",
		authority: "client",
		platforms: ["desktop"],
		semantic:
			"A durable native-client delivery or persistence failure summary became deliverable. Each summary has a stable event ID, bounded categorical dimensions, and a sequence range; it is retried until accepted and never recursively reports its own delivery failure.",
		properties: {
			failure_class: { type: "string", required: true, format: "category" },
			failed_event_name: {
				type: "string",
				required: true,
				format: "category",
			},
			status: { type: "number", nullable: true },
			count: { type: "number", required: true },
			first_sequence: { type: "number", required: true },
			last_sequence: { type: "number", required: true },
			first_failed_at_ms: { type: "number", required: true },
			last_failed_at_ms: { type: "number", required: true },
		},
	},
	onboarding_milestone_completed: {
		...bestEffortClient,
		platforms: ["web"],
		semantic:
			"The onboarding UI observed a successful milestone RPC or an explicit desktop-download action. This supports journey diagnosis but is not the authoritative activation metric.",
		properties: {
			milestone: {
				type: "string",
				required: true,
				values: [
					"welcome",
					"organization_setup",
					"custom_domain",
					"invite_team",
					"download",
					"skip_all",
				],
			},
			skipped: { type: "boolean", required: true },
		},
	},
	export_button_clicked: {
		...bestEffortClient,
		platforms: ["desktop"],
		semantic: "A creator opened the desktop export flow.",
		properties: {},
	},
	export_fps_changed: {
		...bestEffortClient,
		platforms: ["desktop"],
		semantic: "A creator changed the desktop export frame-rate setting.",
		properties: { fps: { type: "number", required: true } },
	},
	export_started: {
		version: 1,
		delivery: "critical",
		authority: "client",
		platforms: ["desktop"],
		semantic:
			"A creator started a local export with a validated destination and format.",
		properties: {
			destination: {
				type: "string",
				required: true,
				values: ["clipboard", "file", "share_link"],
			},
			format: { type: "string", required: true, format: "category" },
			resolution: { type: "string", required: true, format: "category" },
			fps: { type: "number", required: true },
		},
	},
	export_completed: {
		version: 1,
		delivery: "critical",
		authority: "client",
		platforms: ["desktop"],
		semantic: "A creator export reached its terminal success state.",
		properties: {
			destination: {
				type: "string",
				required: true,
				values: ["clipboard", "file", "share_link"],
			},
			format: { type: "string", required: true, format: "category" },
			resolution: { type: "string", required: true, format: "category" },
			fps: { type: "number", required: true },
		},
	},
	export_failed: {
		version: 1,
		delivery: "critical",
		authority: "client",
		platforms: ["desktop"],
		semantic:
			"A creator export reached a terminal failure or cancellation without raw error text.",
		properties: {
			destination: {
				type: "string",
				required: true,
				values: ["clipboard", "file", "share_link"],
			},
			format: { type: "string", required: true, format: "category" },
			resolution: { type: "string", required: true, format: "category" },
			fps: { type: "number", required: true },
			failure_class: {
				type: "string",
				required: true,
				values: [
					"cancelled",
					"authentication",
					"plan",
					"network",
					"render",
					"unknown",
				],
			},
		},
	},
	create_shareable_link_clicked: {
		...bestEffortClient,
		platforms: ["desktop"],
		semantic:
			"A creator requested a shareable link; this is intent and is not a successfully created share.",
		properties: {
			resolution: { type: "string", required: true, format: "category" },
			fps: { type: "number", required: true },
			has_existing_auth: { type: "boolean", required: true },
		},
	},
	share_link_created: {
		...criticalServer,
		platforms: ["cli", "desktop", "mobile", "server"],
		semantic:
			"The authoritative database committed a new shareable video or screenshot owned by the authenticated creator; platform identifies the initiating client when durably known.",
		properties: {
			asset_type: {
				type: "string",
				required: true,
				values: ["recording", "screenshot"],
			},
			recording_mode: { type: "string", nullable: true, format: "category" },
		},
	},
	checkout_started: {
		...criticalServer,
		platforms: ["web", "desktop", "mobile", "cli"],
		semantic:
			"Stripe returned a usable hosted checkout URL for an authenticated Cap account.",
		properties: {
			price_id: { type: "string", required: true, format: "identifier" },
			quantity: { type: "number", required: true },
			is_onboarding: { type: "boolean" },
		},
	},
	guest_checkout_started: {
		...criticalServer,
		platforms: ["web", "mobile"],
		semantic:
			"Stripe returned a usable hosted checkout URL for an anonymous guest checkout.",
		properties: {
			price_id: { type: "string", required: true, format: "identifier" },
			quantity: { type: "number", required: true },
		},
	},
	purchase_completed: {
		...criticalServer,
		version: 3,
		platforms: ["web", "desktop", "mobile", "cli", "server"],
		semantic:
			"Stripe reports either a paid checkout or the first positive settled subscription-cycle invoice after a trial. Immediate checkout invoices are not counted again, and trials without settled money are never purchases.",
		properties: {
			payment_status: { type: "string", required: true, values: ["paid"] },
			subscription_status: {
				type: "string",
				required: true,
				format: "category",
			},
			amount_total_minor: { type: "number", nullable: true },
			amount_subtotal_minor: { type: "number", nullable: true },
			discount_amount_minor: { type: "number", nullable: true },
			currency: { type: "string", nullable: true, format: "category" },
			unit_amount_minor: { type: "number", nullable: true },
			billing_interval: { type: "string", nullable: true, format: "category" },
			billing_interval_count: { type: "number", nullable: true },
			invite_quota: { type: "number", nullable: true },
			price_id: { type: "string", nullable: true, format: "identifier" },
			quantity: { type: "number", nullable: true },
			is_first_purchase: { type: "boolean", required: true },
			is_guest_checkout: { type: "boolean", required: true },
			is_onboarding: { type: "boolean", required: true },
		},
	},
	trial_started: {
		...criticalServer,
		platforms: ["web", "desktop", "mobile", "cli", "server"],
		semantic:
			"Stripe emits an immutable subscription-created event whose initial status is trialing. This is never counted as purchase revenue.",
		properties: {
			subscription_status: {
				type: "string",
				required: true,
				values: ["trialing"],
			},
			trial_end_at: { type: "number", nullable: true },
			price_id: { type: "string", nullable: true, format: "identifier" },
			quantity: { type: "number", nullable: true },
			currency: { type: "string", nullable: true, format: "category" },
			unit_amount_minor: { type: "number", nullable: true },
			billing_interval: { type: "string", nullable: true, format: "category" },
			billing_interval_count: { type: "number", nullable: true },
			is_guest_checkout: { type: "boolean", required: true },
			is_onboarding: { type: "boolean", required: true },
		},
	},
	subscription_renewed: {
		...criticalServer,
		version: 2,
		platforms: ["server"],
		semantic:
			"Stripe reports a paid subscription-cycle invoice. Revenue is recorded in minor units and never mixed across currencies.",
		properties: {
			amount_paid_minor: { type: "number", required: true },
			currency: { type: "string", required: true, format: "category" },
			price_id: { type: "string", required: true, format: "identifier" },
			billing_reason: {
				type: "string",
				required: true,
				values: ["subscription_cycle"],
			},
		},
	},
	trial_converted: {
		...criticalServer,
		version: 2,
		platforms: ["server"],
		semantic:
			"An authoritative Stripe subscription transition changed from trialing to active. This does not itself imply a paid invoice.",
		properties: {
			previous_status: {
				type: "string",
				required: true,
				values: ["trialing"],
			},
			new_status: {
				type: "string",
				required: true,
				values: ["active"],
			},
			price_id: { type: "string", required: true, format: "identifier" },
		},
	},
	subscription_changed: {
		...criticalServer,
		version: 2,
		platforms: ["server"],
		semantic:
			"Stripe changed a subscription's status, cancellation schedule, plan, or seat quantity. The typed change kind defines the decision meaning.",
		properties: {
			change_kind: {
				type: "string",
				required: true,
				values: [
					"status",
					"plan",
					"seats",
					"cancellation_scheduled",
					"cancellation_reversed",
				],
			},
			previous_status: { type: "string", nullable: true, format: "category" },
			new_status: { type: "string", nullable: true, format: "category" },
			previous_price_id: {
				type: "string",
				nullable: true,
				format: "identifier",
			},
			new_price_id: {
				type: "string",
				required: true,
				format: "identifier",
			},
			previous_quantity: { type: "number", nullable: true },
			new_quantity: { type: "number", nullable: true },
		},
	},
	subscription_cancelled: {
		...criticalServer,
		version: 2,
		platforms: ["server"],
		semantic:
			"Stripe reports that a subscription has terminated. This is the churn boundary, distinct from scheduling cancellation.",
		properties: {
			status: { type: "string", required: true, format: "category" },
			price_id: { type: "string", required: true, format: "identifier" },
			ended_at: { type: "number", nullable: true },
			cancel_at_period_end: { type: "boolean", required: true },
		},
	},
	subscription_refunded: {
		...criticalServer,
		version: 2,
		platforms: ["server"],
		semantic:
			"Stripe reports an incremental increase in money refunded against a settled charge. Each event contributes only the delta since the previous charge state.",
		properties: {
			amount_refunded_minor: { type: "number", required: true },
			currency: { type: "string", required: true, format: "category" },
			price_id: { type: "string", required: true, format: "identifier" },
			fully_refunded: { type: "boolean", required: true },
		},
	},
	subscription_payment_failed: {
		...criticalServer,
		version: 2,
		platforms: ["server"],
		semantic:
			"Stripe reports that collection failed for a subscription invoice. Attempt count is provider-authoritative.",
		properties: {
			amount_due_minor: { type: "number", required: true },
			currency: { type: "string", required: true, format: "category" },
			attempt_count: { type: "number", required: true },
			price_id: { type: "string", required: true, format: "identifier" },
		},
	},
	organization_invite_sent: {
		...criticalServer,
		platforms: ["web"],
		semantic:
			"One or more organization invitations were durably created and sent.",
		properties: {
			invite_count: { type: "number", required: true },
			admin_count: { type: "number", required: true },
			member_count: { type: "number", required: true },
			delivery: { type: "string", required: true, values: ["email"] },
		},
	},
	organization_member_joined: {
		...criticalServer,
		platforms: ["web"],
		semantic:
			"An invited user became an organization member in the authoritative database.",
		properties: {
			role: { type: "string", required: true, values: ["admin", "member"] },
			assigned_pro_seat: { type: "boolean", required: true },
		},
	},
	collaboration_action_created: {
		...criticalServer,
		platforms: ["server"],
		semantic:
			"The authoritative comments table contains a new comment, reply, or reaction. Content and reaction values are never collected.",
		properties: {
			action: {
				type: "string",
				required: true,
				values: ["comment", "reply", "reaction"],
			},
		},
	},
	seat_quantity_changed: {
		...criticalServer,
		platforms: ["web"],
		semantic:
			"Stripe accepted an organization subscription quantity change and the local database was updated.",
		properties: {
			previous_quantity: { type: "number", required: true },
			new_quantity: { type: "number", required: true },
			quantity_delta: { type: "number", required: true },
			direction: {
				type: "string",
				required: true,
				values: ["increase", "decrease"],
			},
			price_id: { type: "string", required: true, format: "identifier" },
			unit_amount_minor: { type: "number", nullable: true },
			currency: { type: "string", required: true, format: "category" },
			billing_interval: { type: "string", nullable: true, format: "category" },
		},
	},
	loom_import_started: {
		...criticalServer,
		platforms: ["server"],
		semantic:
			"A claimed Loom import entered the durable media import workflow.",
		properties: {
			import_mode: { type: "string", required: true, format: "category" },
		},
	},
	loom_import_completed: {
		...criticalServer,
		platforms: ["server"],
		semantic:
			"A Loom import completed with its media and metadata committed to Cap storage.",
		properties: {
			import_mode: { type: "string", required: true, format: "category" },
			duration_ms: { type: "number", required: true },
		},
	},
	loom_import_failed: {
		...criticalServer,
		platforms: ["server"],
		semantic:
			"A Loom import reached a terminal failure after workflow retries.",
		properties: {
			import_mode: { type: "string", required: true, format: "category" },
			failure_class: {
				type: "string",
				required: true,
				format: "category",
			},
		},
	},
	first_view_received: {
		...criticalServer,
		platforms: ["server"],
		semantic:
			"The first non-owner, non-synthetic playback view was accepted for a video; deterministic event identity makes this milestone idempotent.",
		properties: {},
	},
	camera_selected: {
		...bestEffortClient,
		platforms: ["desktop"],
		semantic: "A creator changed whether camera capture is enabled.",
		properties: { enabled: { type: "boolean", required: true } },
	},
	microphone_selected: {
		...bestEffortClient,
		platforms: ["desktop"],
		semantic: "A creator changed whether microphone capture is enabled.",
		properties: { enabled: { type: "boolean", required: true } },
	},
	screenshot_view_clicked: {
		...bestEffortClient,
		platforms: ["desktop"],
		semantic: "A creator opened a screenshot from the desktop library.",
		properties: {},
	},
	screenshot_editor_clicked: {
		...bestEffortClient,
		platforms: ["desktop"],
		semantic: "A creator opened a screenshot in the editor.",
		properties: {},
	},
	screenshot_folder_clicked: {
		...bestEffortClient,
		platforms: ["desktop"],
		semantic: "A creator requested the folder containing a screenshot.",
		properties: {},
	},
	screenshot_copy_clicked: {
		...bestEffortClient,
		platforms: ["desktop"],
		semantic: "A creator copied a screenshot to the clipboard.",
		properties: {},
	},
	screenshot_share_clicked: {
		...bestEffortClient,
		platforms: ["desktop"],
		semantic: "A creator requested sharing for a screenshot.",
		properties: {},
	},
	recording_view_clicked: {
		...bestEffortClient,
		platforms: ["desktop"],
		semantic: "A creator opened a recording from the desktop library.",
		properties: {},
	},
	recording_folder_clicked: {
		...bestEffortClient,
		platforms: ["desktop"],
		semantic: "A creator requested the folder containing a recording.",
		properties: {},
	},
	recording_copy_clicked: {
		...bestEffortClient,
		platforms: ["desktop"],
		semantic: "A creator copied a recording to the clipboard.",
		properties: {},
	},
	recording_editor_clicked: {
		...bestEffortClient,
		platforms: ["desktop"],
		semantic: "A creator opened a recording in the editor.",
		properties: {},
	},
	tool_interaction: {
		...bestEffortClient,
		platforms: ["web"],
		semantic:
			"A bounded lifecycle interaction with one of Cap's public in-browser media tools.",
		properties: {
			tool: {
				type: "string",
				required: true,
				values: ["trimmer", "speed_controller", "media_converter"],
			},
			action: {
				type: "string",
				required: true,
				values: [
					"loaded",
					"invalid_file_type",
					"file_too_large",
					"file_selected",
					"process_started",
					"process_completed",
					"process_failed",
					"download",
					"reset",
				],
			},
			source_format: { type: "string", format: "category" },
			target_format: { type: "string", format: "category" },
			operation: { type: "string", format: "category" },
			mime_category: { type: "string", format: "category" },
			input_size_bucket: { type: "string", format: "category" },
			output_size_bucket: { type: "string", format: "category" },
			duration_ms: { type: "number" },
			speed_factor: { type: "number" },
			failure_class: { type: "string", format: "category" },
		},
	},
	experiment_exposed: {
		...bestEffortClient,
		platforms: ["web"],
		semantic:
			"A stable experiment assignment was rendered to an actor; conversions never infer exposure.",
		properties: {
			experiment_id: {
				type: "string",
				required: true,
				format: "identifier",
			},
			variant: { type: "string", required: true, format: "identifier" },
			assignment_version: {
				type: "string",
				required: true,
				format: "identifier",
			},
		},
	},
} as const satisfies Record<string, EventDefinition>;

export type CoreEventName = keyof typeof EVENT_REGISTRY;

type RuleValue<Rule extends EventPropertyRule> = Rule["type"] extends "string"
	? Rule extends { values: readonly (infer Value extends string)[] }
		? Value
		: string
	: Rule["type"] extends "number"
		? number
		: boolean;

type NullableRuleValue<Rule extends EventPropertyRule> =
	| RuleValue<Rule>
	| (Rule extends { nullable: true } ? null : never);

type RequiredPropertyKeys<Schema extends Record<string, EventPropertyRule>> = {
	[Key in keyof Schema]: Schema[Key] extends { required: true } ? Key : never;
}[keyof Schema];

type OptionalPropertyKeys<Schema extends Record<string, EventPropertyRule>> =
	Exclude<keyof Schema, RequiredPropertyKeys<Schema>>;

type PropertiesFromSchema<Schema extends Record<string, EventPropertyRule>> = {
	[Key in RequiredPropertyKeys<Schema>]: NullableRuleValue<Schema[Key]>;
} & {
	[Key in OptionalPropertyKeys<Schema>]?: NullableRuleValue<Schema[Key]>;
};

export type ProductEventPropertiesFor<Name extends CoreEventName> =
	PropertiesFromSchema<(typeof EVENT_REGISTRY)[Name]["properties"]>;

export type ProductEventPlatformFor<Name extends CoreEventName> =
	(typeof EVENT_REGISTRY)[Name]["platforms"][number];

export type ProductEventArguments<Name extends CoreEventName> =
	keyof (typeof EVENT_REGISTRY)[Name]["properties"] extends never
		? [properties?: undefined]
		: RequiredPropertyKeys<
					(typeof EVENT_REGISTRY)[Name]["properties"]
				> extends never
			? [properties?: ProductEventPropertiesFor<Name>]
			: [properties: ProductEventPropertiesFor<Name>];

export type ProductEventPropertyField<Name extends CoreEventName> =
	ProductEventArguments<Name> extends [properties: infer Properties]
		? { properties: Properties }
		: ProductEventArguments<Name> extends [properties?: infer Properties]
			? { properties?: Properties }
			: never;

export type ClientProductEventName = {
	[Name in CoreEventName]: (typeof EVENT_REGISTRY)[Name]["authority"] extends "server"
		? never
		: Name;
}[CoreEventName];

export type ClientProductEventNameForPlatform<
	Platform extends ProductEventPlatform,
> = {
	[Name in CoreEventName]: (typeof EVENT_REGISTRY)[Name]["authority"] extends "server"
		? never
		: Platform extends (typeof EVENT_REGISTRY)[Name]["platforms"][number]
			? Name
			: never;
}[CoreEventName];

export type ServerProductEventName = {
	[Name in CoreEventName]: (typeof EVENT_REGISTRY)[Name]["authority"] extends "client"
		? never
		: Name;
}[CoreEventName];

export type ServerProductEventNameForPlatform<
	Platform extends ProductEventPlatform,
> = {
	[Name in ServerProductEventName]: Platform extends ProductEventPlatformFor<Name>
		? Name
		: never;
}[ServerProductEventName];

export const CORE_EVENT_NAMES = Object.freeze(
	Object.keys(EVENT_REGISTRY) as CoreEventName[],
);

export const SERVER_ONLY_EVENT_NAMES = Object.freeze(
	CORE_EVENT_NAMES.filter(
		(name) => EVENT_REGISTRY[name].authority === "server",
	),
);

export function isCoreEventName(value: string): value is CoreEventName {
	return Object.hasOwn(EVENT_REGISTRY, value);
}

export function isServerOnlyEventName(value: CoreEventName) {
	return EVENT_REGISTRY[value].authority === "server";
}

export function getProductEventDefinition<Name extends CoreEventName>(
	eventName: Name,
) {
	return EVENT_REGISTRY[eventName];
}
