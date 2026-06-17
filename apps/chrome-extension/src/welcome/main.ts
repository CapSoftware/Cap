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
