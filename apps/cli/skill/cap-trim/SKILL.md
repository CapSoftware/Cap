---
name: cap-trim
description: Trim clip edges in a local Cap Studio recording that is open in the editor - inspect the timeline, cut one edge at a time through Cap's local MCP tools, and verify the result on disk. Use when the user wants a recording shortened, tightened, or cut without touching the project file from outside the editor.
---

# cap-trim

Shorten a recording by moving clip edges in Cap Studio. The editor applies the
edit through its own clamps, undo history and save path, so the timeline the
user is looking at stays true.

> **The trim needs the recording open in Cap Studio.** Inspecting a timeline
> reads the project file and works on any `.cap` project; trimming is applied
> to the running editor. If the project is not open, the tool refuses and says
> so - there is no path that trims it in the background.

## Why the editor, and not the project file

`project-config.json` belongs to the editor: it holds that editor's undo
history and it rewrites the file on every save. Writing the file from outside
is overwritten the next time the editor saves, so the timeline on screen and
the timeline on disk disagree. Every step below goes through the editor.

## Workflow

1. Find the project. A `.cap` directory on disk:

   ```sh
   cap recordings list --json
   ```

   If the user names a recording that is not in the library, ask for its path.

2. Read the timeline with the `studio_timeline_inspect` MCP tool, passing the
   project's `project_path`. It returns the project's clips, each with
   `clipIndex`, `startSeconds` and `endSeconds` in recording seconds. Those
   seconds are the unit the whole workflow uses.

3. Show the user the exact edit - clip index, edge, current value, requested
   value - and get explicit confirmation. A trim changes their recording.

4. Apply it with the `studio_timeline_trim` MCP tool:

   | Field | Value |
   |---|---|
   | `project_path` | the `.cap` directory |
   | `clip_index` | the index from step 2 |
   | `edge` | `start` or `end` |
   | `time_seconds` | where the edge should land, in recording seconds |
   | `expected_current_seconds` | the edge's current value, from step 2 |
   | `confirmed` | `true`, after the user confirmed |

5. Read the result. `appliedSeconds` is where the edge ended up after the
   editor's clamps, `clamped` says whether that differs from what was asked
   for, and `verifiedOnDisk` says whether the project file already holds the
   new edge. A failed trim comes back as an error whose message is the
   editor's own reason.

6. Export a copy when the user wants to check it:

   ```sh
   cap export <path.cap> --output out.mp4 --json
   ```

## Rules

- `expected_current_seconds` is the value from the inspection. If the editor
  has moved on since, the trim is refused as stale: inspect again and retry
  with the new value rather than guessing.
- One edge per call. The end of one clip and the start of the next are two
  calls, each confirmed on its own.
- The editor's clamps win. A trim that would make a clip shorter than the
  minimum, cross a neighbour, or run past the recording is clamped, and the
  response says where the edge actually landed.
- A refusal is information, not an obstacle to retry. Report the editor's own
  reason - a drag still in progress, a stale edge, a project that is not open.
- Never write `project-config.json` to change the timeline of a project that is
  open in Cap Studio.
