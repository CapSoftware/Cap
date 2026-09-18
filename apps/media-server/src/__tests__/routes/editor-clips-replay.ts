import { replayEditorClips } from "./editor-clips-scenario";

const result = await replayEditorClips();
process.stdout.write(`${JSON.stringify(result)}\n`);
