// The project a native recording belongs to, and the settings it is processed with.
// The desktop writes the chosen project into the walk request (native-walk.json "project");
// processing copies it into session.json and chapter.json, where the engine's sessionProject
// finds it. Once session.json exists its "project" wins, because a saved recording can be
// moved to another project (or to none) after it was made.
import fs from "node:fs";
import path from "node:path";

const local = new URL("./src/projects.mjs", import.meta.url);
const engine = fs.existsSync(local)
	? new URL("./src/", import.meta.url)
	: new URL("../../../vendor/ux-walk/src/", import.meta.url);
const { readProject, withProject } = await import(
	new URL("projects.mjs", engine)
);
const { glossaryPath } = await import(new URL("glossary.mjs", engine));

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

// The project id the recording names, or null.
export function recordingProjectId(journal) {
	const session = readJson(
		path.join(journal.request.directory, "session.json"),
	);
	if (session && Object.hasOwn(session, "project"))
		return typeof session.project === "string" && session.project
			? session.project
			: null;
	const requested = journal.request.project;
	return typeof requested === "string" && requested ? requested : null;
}

// The settings one recording runs with: the engine's withProject over the loaded config, so
// the project's glossary joins the configured ones and its source folder, context notes and
// URL win. A project whose file is gone or invalid processes like no project, and a project
// glossary whose file is missing is left out rather than failing the recording. The id stays
// what the recording named, so moving it back later still works.
export function withRecordingProject(journal, cfg) {
	const id = recordingProjectId(journal);
	let project = null;
	try {
		project = id ? readProject(cfg, id) : null;
	} catch {}
	if (project?.glossary && !fs.existsSync(glossaryPath(project.glossary)))
		project = { ...project, glossary: null };
	return { cfg: { ...withProject(cfg, project), project: id }, project: id };
}

// The same for a journal file, for the checkpoint worker's live transcription (its glossary
// terms). An unreadable journal leaves the config as it was; the worker reports that itself.
export function withJournalProject(file, cfg) {
	try {
		const journal = JSON.parse(fs.readFileSync(file, "utf8"));
		if (journal?.request?.directory)
			return withRecordingProject(journal, cfg).cfg;
	} catch {}
	return cfg;
}
