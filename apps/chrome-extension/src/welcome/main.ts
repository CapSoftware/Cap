import { capabilities } from "../platform/capabilities";
import { mountPageNav } from "../shared/page-nav";
import { sendServiceWorkerMessage } from "../shared/runtime";
import { loadAuth } from "../shared/storage";
import "./styles.css";

mountPageNav("welcome");

const byId = <T extends HTMLElement>(id: string): T => {
	const element = document.getElementById(id);
	if (!element) throw new Error(`Missing element: ${id}`);
	return element as T;
};

const stage = byId<HTMLElement>("stage");
const signInButton = byId<HTMLButtonElement>("sign-in");
const signedInPill = byId<HTMLElement>("signed-in");
const ctaNote = byId<HTMLElement>("cta-note");

let authPollId: number | null = null;

const showSignedIn = () => {
	if (authPollId !== null) {
		window.clearInterval(authPollId);
		authPollId = null;
	}
	stage.dataset.mode = "ready";
	signInButton.hidden = true;
	ctaNote.hidden = true;
	signedInPill.hidden = false;
};

const checkAuth = async () => {
	const auth = await loadAuth().catch(() => null);
	if (auth) showSignedIn();
};

signInButton.addEventListener("click", () => {
	ctaNote.hidden = false;
	void sendServiceWorkerMessage({
		target: "service-worker",
		type: "auth-start",
	}).catch(() => undefined);
});

authPollId = window.setInterval(() => void checkAuth(), 1000);
void checkAuth();

// Firefox treats MV3 host permissions as opt-in, so the declared content
// script (overlay, countdown, recording bar) stays inert until the user
// grants access here. The click on the button supplies the required user
// gesture for permissions.request.
// file:///* is declared in the Firefox manifest and must be included here;
// without it the user can grant http/https but the content script still won't
// inject on local file:// pages even though the manifest advertises support.
const HOST_PERMISSION_ORIGINS = ["http://*/*", "https://*/*", "file:///*"];

if (!capabilities.hostPermissionsGrantedAtInstall) {
	const hostPermissionRow = byId<HTMLElement>("host-permission-row");
	const hostPermissionNote = byId<HTMLElement>("host-permission-note");
	const grantHostsButton = byId<HTMLButtonElement>("grant-hosts");
	const hostsGrantedPill = byId<HTMLElement>("hosts-granted");

	const reflectHostPermission = (granted: boolean) => {
		grantHostsButton.hidden = granted;
		hostsGrantedPill.hidden = !granted;
		hostPermissionNote.hidden = granted;
	};

	hostPermissionRow.hidden = false;
	hostPermissionNote.hidden = false;
	chrome.permissions.contains({ origins: HOST_PERMISSION_ORIGINS }, (granted) =>
		reflectHostPermission(Boolean(granted)),
	);
	grantHostsButton.addEventListener("click", () => {
		chrome.permissions.request(
			{ origins: HOST_PERMISSION_ORIGINS },
			(granted) => reflectHostPermission(Boolean(granted)),
		);
	});
}
