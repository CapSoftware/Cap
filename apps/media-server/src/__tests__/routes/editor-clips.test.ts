import { test } from "bun:test";
import { replayEditorClips } from "./editor-clips-scenario";

const hasNativeBinaries =
	!!process.env.CAP_WEB_EDITOR_PREPARE_BIN &&
	!!process.env.CAP_WEB_EDITOR_SERVICE_BIN;

test.skipIf(!hasNativeBinaries)(
	"a saved screen clip with a separate camera survives preparation, preview, and export",
	replayEditorClips,
);
