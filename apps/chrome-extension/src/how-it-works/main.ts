import { mountPageNav } from "../shared/page-nav";
import { RECORDER_OPEN_PARAM } from "../shared/recorder-pages";
import "./styles.css";

// Read before the page nav drops the flag from the URL.
const openedInPlaceOfBrowserPage =
	new URLSearchParams(window.location.search).get(RECORDER_OPEN_PARAM) ===
	"open";
const recorderNote = document.getElementById("recorder-note");
if (recorderNote && openedInPlaceOfBrowserPage) recorderNote.hidden = false;

mountPageNav("how-it-works");
