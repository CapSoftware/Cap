# Stream C: AI Extraction Context

**Workstream:** Extract ticket fields from video transcripts using AI

**Dependencies:** None - can start immediately

**Prerequisites:** Clone repo, understand existing AI pattern

---

## Key Files to Understand

### Existing AI Pattern
- `apps/web/actions/videos/generate-ai-metadata.ts` - Reference implementation
- Uses Groq (primary) with OpenAI fallback
- Fetches transcript from S3, calls LLM, parses JSON response

### Transcript Access
```typescript
import { S3Buckets } from "@cap/web-backend";
import { Effect, Option } from "effect";
import { runPromise } from "@/lib/server";

const vtt = await Effect.gen(function* () {
  const [bucket] = yield* S3Buckets.getBucketAccess(
    Option.fromNullable(bucketId)
  );
  return yield* bucket.getObject(`${userId}/${videoId}/transcription.vtt`);
}).pipe(runPromise);
```

### VTT Parsing
```typescript
const transcriptText = vtt.value
  .split("\n")
  .filter(
    (l) =>
      l.trim() &&
      l !== "WEBVTT" &&
      !/^\d+$/.test(l.trim()) &&
      !l.includes("-->")
  )
  .join(" ")
  .trim();
```

### OpenAI Call Pattern
```typescript
const response = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${serverEnv().OPENAI_API_KEY}`,
  },
  body: JSON.stringify({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
  }),
});
```

---

## Tasks in This Stream

1. **C1:** Create `apps/web/actions/integrations/extract-ticket.ts`
2. **C2:** Create `apps/web/actions/integrations/create-notion-ticket.ts`

---

## Extraction Prompt

```
You are analyzing a transcript from a screen recording that reports a bug, requests a feature, or describes a task. Extract:

1. Title: Concise ticket title (max 80 chars)
2. Ticket Type: [Bug, Feature, Enhancement, Task]
3. Priority: [Low, Medium, High, Critical]
4. Description: 2-3 sentence summary
5. Steps to Reproduce: Numbered list (if applicable)

Respond ONLY with valid JSON.
```

---

## Output Types

```typescript
export type ExtractedTicket = {
  title: string;
  ticketType: "Bug" | "Feature" | "Enhancement" | "Task";
  priority: "Low" | "Medium" | "High" | "Critical";
  description: string;
  stepsToReproduce: string[];
};

export type CreateTicketInput = {
  videoId: Video.VideoId;
  title: string;
  ticketType: "Bug" | "Feature" | "Enhancement" | "Task";
  priority: "Low" | "Medium" | "High" | "Critical";
  productArea?: string;
  description: string;
  stepsToReproduce: string[];
};
```

---

## Notion Page Creation

```typescript
// POST https://api.notion.com/v1/pages
{
  parent: { database_id: databaseId },
  properties: {
    Name: { title: [{ text: { content: title } }] },
    "Ticket Type": { select: { name: ticketType } },
    Priority: { select: { name: priority } },
    "Product Area": { rich_text: [{ text: { content: productArea } }] },
  },
  children: [
    // Block content for description, steps, video link
  ]
}
```

---

## Error Handling

- Verify transcription is COMPLETE before extraction
- Handle empty/short transcripts gracefully
- Validate AI response has required fields
- Fallback defaults for invalid type/priority

---

## Handoff to Stream D

Stream D (Frontend) depends on:
- `extractTicketFromVideo(videoId)` action working
- `createNotionTicket(input)` action working

Provide: Working extraction and creation actions
