# Auto Mode Implementation Plan

## Feature Overview

Auto Mode is an AI-powered feature that allows users to describe a recording they want to create, and the system will automatically:
1. Gather requirements through an interactive questionnaire
2. Optionally scrape a target website for context
3. Generate a narration script and action choreography using AI
4. Execute browser automation in the cloud while recording
5. Generate TTS narration and merge it with the recording
6. Apply a polished background/styling to the final video
7. Save the result to the user's Cap library

**Key Difference from Existing Recording**: Unlike the current web recorder which uses client-side MediaRecorder API, Auto Mode runs entirely server-side with headless browser automation and screen capture in the cloud.

---

## Status

- **Current Status**: In Progress
- **Current Active Task**: None (Task 1.2 completed, awaiting next session)
- **Last Updated**: 2026-01-10
- **Completed Tasks**: Task 1.1, Task 1.2

---

## Agent Instructions

**CRITICAL: ONE TASK AT A TIME**
- Complete ONLY ONE task per session, then STOP
- After completing a task, notify the user so they can review and reset context
- Do NOT continue to the next task even if it seems quick or related
- The user will say "continue the plan" or "resume the plan" to proceed with the next task

When continuing this plan:
1. Read the entire plan to understand context and previous learnings
2. Find the current active task (marked with `[~]`) or the next `[ ]` task
3. Before starting, update the task status to `[~]` and set "Current Active Task" in the header
4. After completing, mark `[x]`, add notes with learnings, and update any affected future tasks
5. If you discover new requirements, add them as tasks in the appropriate phase
6. If blocked, mark `[!]` and document the blocker, then move to the next unblocked task
7. Update "Key Decisions" when making architectural choices
8. Always run `pnpm lint` and `pnpm typecheck` after code changes
9. Follow existing patterns from `apps/web/app/(org)/dashboard/caps/` for UI structure
10. Use `"use server"` for Server Actions, `"use workflow"` and `"use step"` for background jobs
11. Never add code comments - code must be self-documenting
12. After completing the task, commit and push to the current branch with a descriptive title only (no commit body)
13. STOP after completing one task and notify the user

---

## Key Decisions Log

| Decision | Rationale | Date |
|----------|-----------|------|
| (decisions will be logged here as they're made) | | |

---

## Open Questions

1. **TTS Provider**: Which TTS service to use? Options: ElevenLabs, OpenAI TTS, Azure Cognitive Services, Google Cloud TTS
2. **Browser Automation**: Playwright vs Puppeteer? (Playwright recommended for better cross-browser support)
3. **Recording Method**: How to capture headless browser output? Options: Playwright video recording, FFmpeg screen capture, custom solution
4. **Video Background**: What styles/templates for the polished background?
5. **Hosting Infrastructure**: Where to run headless browsers? Consider serverless options vs dedicated instances
6. **Usage Limits**: What limits for free vs pro users?

---

## Phase 1: Foundation & Page Setup

### Task 1.1: Create Auto Mode Dashboard Route
- [x] **Status**: Completed (2026-01-08)
- **Description**: Set up the basic route structure for `/dashboard/auto-mode` following existing dashboard patterns
- **Files**:
  - `apps/web/app/(org)/dashboard/auto-mode/page.tsx` (create)
  - `apps/web/app/(org)/dashboard/auto-mode/AutoMode.tsx` (create)
  - `apps/web/app/(org)/dashboard/auto-mode/loading.tsx` (create)
- **Acceptance Criteria**:
  - Route accessible at `/dashboard/auto-mode`
  - Page renders with basic layout matching other dashboard pages
  - Loading state works correctly
  - Authentication check redirects unauthenticated users
- **Pattern Reference**: Follow `apps/web/app/(org)/dashboard/caps/page.tsx` and `Caps.tsx`
- **Notes**: Created basic page structure with placeholder UI showing disabled prompt input and "coming soon" messaging. Uses @cap/ui Button component and FontAwesome icons. The AutoMode component accepts userId prop for future use. Loading skeleton matches the centered layout of the main page.

### Task 1.2: Create Initial Prompt Input UI
- [x] **Status**: Completed (2026-01-10)
- **Description**: Build the main prompt input component where users describe what they want to record
- **Files**:
  - `apps/web/app/(org)/dashboard/auto-mode/components/PromptInput.tsx` (create)
  - `apps/web/app/(org)/dashboard/auto-mode/components/index.ts` (create)
- **Acceptance Criteria**:
  - Large, centered text input with placeholder "What would you like to record?"
  - Submit button that transitions to questionnaire
  - Matches Cap design system (using `@cap/ui` components)
  - Responsive design for mobile/desktop
- **UI Components to Use**: `Button`, `Input` from `@cap/ui`
- **Notes**: Created PromptInput component with controlled textarea input, ⌘+Enter keyboard shortcut for submission, loading/disabled states, and proper styling using @cap/ui Button and @cap/utils classNames. Updated AutoMode.tsx to use the component with a simple state machine (prompt → questionnaire) and placeholder questionnaire UI. The component is fully functional and ready for the questionnaire to be implemented in Phase 3.

### Task 1.3: Add Auto Mode to Dashboard Navigation
- [ ] **Status**: Not started
- **Description**: Add navigation link to Auto Mode in the dashboard sidebar/header
- **Files**:
  - Need to identify where dashboard nav is defined (likely in layout or shared component)
- **Acceptance Criteria**:
  - "Auto Mode" or "AI Recording" link visible in dashboard navigation
  - Active state when on auto-mode route
  - Appropriate icon (wand, sparkles, or similar)
- **Notes**: (to be added during implementation)

---

## Phase 2: Database Schema & Types

### Task 2.1: Design Auto Mode Database Schema
- [ ] **Status**: Not started
- **Description**: Design and implement database tables for storing auto mode sessions, plans, and execution state
- **Files**:
  - `packages/database/schema.ts` (modify - add new tables)
- **Schema Design**:
  ```typescript
  autoModeSessions = mysqlTable("auto_mode_sessions", {
    id: nanoId("id").notNull().primaryKey(),
    userId: nanoId("userId").notNull(),
    orgId: nanoId("orgId").notNull(),
    status: varchar("status", { length: 50 }).notNull(), // draft, planning, ready, executing, processing, completed, failed
    prompt: text("prompt").notNull(),
    targetUrl: varchar("targetUrl", { length: 2048 }),
    scrapedContext: json("scrapedContext"),
    questionnaire: json("questionnaire"), // user's answers
    generatedPlan: json("generatedPlan"), // AI-generated script + actions
    executionLog: json("executionLog"), // runtime execution details
    resultVideoId: nanoId("resultVideoId"), // FK to videos table
    errorMessage: text("errorMessage"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
  });
  ```
- **Acceptance Criteria**:
  - Tables created with proper indexes
  - Relations defined
  - Migration generated and tested
- **Notes**: (to be added during implementation)

### Task 2.2: Create TypeScript Types for Auto Mode
- [ ] **Status**: Not started
- **Description**: Define TypeScript types/interfaces for Auto Mode domain objects
- **Files**:
  - `packages/web-domain/src/AutoMode.ts` (create)
  - `packages/web-domain/src/index.ts` (modify - export new types)
- **Types to Define**:
  - `AutoModeSession` - full session object
  - `AutoModePlan` - AI-generated plan structure
  - `AutoModeAction` - individual action (click, scroll, wait, type)
  - `NarrationSegment` - script segment with timing
  - `QuestionnaireAnswers` - structured questionnaire responses
  - `ScrapedContext` - website scraping results
- **Acceptance Criteria**:
  - All types properly typed (no `any`)
  - Types exported from `@cap/web-domain`
  - Consistent with existing type patterns
- **Notes**: (to be added during implementation)

### Task 2.3: Generate Database Migration
- [ ] **Status**: Not started
- **Description**: Generate and apply the Drizzle migration for new Auto Mode tables
- **Commands**:
  ```bash
  pnpm db:generate
  pnpm db:push
  ```
- **Acceptance Criteria**:
  - Migration file generated in `packages/database/migrations/`
  - Migration applies successfully
  - Schema verified with `pnpm --dir packages/database db:check`
- **Notes**: (to be added during implementation)

---

## Phase 3: Questionnaire Flow

### Task 3.1: Design Questionnaire State Machine
- [ ] **Status**: Not started
- **Description**: Design the multi-step questionnaire flow as a state machine
- **Files**:
  - `apps/web/app/(org)/dashboard/auto-mode/hooks/useQuestionnaireFlow.ts` (create)
- **Questionnaire Steps**:
  1. **Target URL** (optional): "Enter the URL of the website/app you want to record"
  2. **Recording Focus**: "What do you want to showcase?" (feature demo, bug report, tutorial, walkthrough)
  3. **Key Actions**: "What specific actions should be shown?" (free-text or structured)
  4. **Narration Tone**: "What tone should the narration have?" (professional, casual, educational, enthusiastic)
  5. **Duration Preference**: "How long should the video be?" (30s, 1min, 2min, 5min, as needed)
  6. **Additional Context**: "Any other details the AI should know?"
- **Acceptance Criteria**:
  - Hook manages step navigation (next, back, skip)
  - Validates required fields per step
  - Persists state (localStorage or server)
  - Handles conditional steps (e.g., URL step enables scraping)
- **Notes**: (to be added during implementation)

### Task 3.2: Build Questionnaire UI Components
- [ ] **Status**: Not started
- **Description**: Create the visual components for each questionnaire step
- **Files**:
  - `apps/web/app/(org)/dashboard/auto-mode/components/Questionnaire/QuestionnaireContainer.tsx` (create)
  - `apps/web/app/(org)/dashboard/auto-mode/components/Questionnaire/StepIndicator.tsx` (create)
  - `apps/web/app/(org)/dashboard/auto-mode/components/Questionnaire/UrlStep.tsx` (create)
  - `apps/web/app/(org)/dashboard/auto-mode/components/Questionnaire/FocusStep.tsx` (create)
  - `apps/web/app/(org)/dashboard/auto-mode/components/Questionnaire/ActionsStep.tsx` (create)
  - `apps/web/app/(org)/dashboard/auto-mode/components/Questionnaire/ToneStep.tsx` (create)
  - `apps/web/app/(org)/dashboard/auto-mode/components/Questionnaire/DurationStep.tsx` (create)
  - `apps/web/app/(org)/dashboard/auto-mode/components/Questionnaire/ContextStep.tsx` (create)
  - `apps/web/app/(org)/dashboard/auto-mode/components/Questionnaire/index.ts` (create)
- **Acceptance Criteria**:
  - Each step renders correctly with proper validation
  - Smooth transitions between steps
  - Progress indicator shows current step
  - Back/Next/Skip buttons work correctly
  - Mobile-responsive layout
- **Notes**: (to be added during implementation)

### Task 3.3: Create Session Server Action
- [ ] **Status**: Not started
- **Description**: Create Server Action to create and update Auto Mode sessions
- **Files**:
  - `apps/web/actions/auto-mode/create-session.ts` (create)
  - `apps/web/actions/auto-mode/update-session.ts` (create)
- **Acceptance Criteria**:
  - Creates session with initial prompt
  - Updates session with questionnaire answers
  - Validates user ownership
  - Returns session ID for client state
- **Pattern Reference**: Follow `apps/web/actions/videos/settings.ts`
- **Notes**: (to be added during implementation)

---

## Phase 4: Website Scraping

### Task 4.1: Research Website Scraping Approach
- [ ] **Status**: Not started
- **Description**: Research and decide on the best approach for scraping target websites
- **Options to Evaluate**:
  1. **Cheerio/JSDOM** - Simple HTML parsing, no JS execution
  2. **Puppeteer** - Full browser, can handle SPAs
  3. **Playwright** - Similar to Puppeteer, better API
  4. **Third-party API** - Firecrawl, ScrapingBee, etc.
- **Considerations**:
  - Need to handle SPAs (React, Vue, etc.)
  - Rate limiting and respectful scraping
  - Cost implications
  - Server-side execution constraints
- **Acceptance Criteria**:
  - Decision documented in Key Decisions Log
  - Proof of concept working
- **Notes**: (to be added during implementation)

### Task 4.2: Implement Website Scraper Service
- [ ] **Status**: Not started
- **Description**: Build the server-side website scraping functionality
- **Files**:
  - `apps/web/actions/auto-mode/scrape-website.ts` (create)
  - `apps/web/lib/scraper/WebsiteScraper.ts` (create)
  - `apps/web/lib/scraper/types.ts` (create)
- **Scraping Output**:
  ```typescript
  interface ScrapedContext {
    url: string;
    title: string;
    metaDescription: string;
    navigation: { label: string; href: string }[];
    headings: { level: number; text: string }[];
    mainContent: string; // summarized/truncated
    interactiveElements: { type: string; label: string; selector: string }[];
    screenshots?: { url: string; description: string }[];
    scrapedAt: string;
  }
  ```
- **Acceptance Criteria**:
  - Extracts meaningful structure from target URL
  - Handles common error cases (404, timeout, blocked)
  - Returns structured data usable by AI
  - Respects robots.txt (optional for first version)
  - Rate limiting in place
- **Notes**: (to be added during implementation)

### Task 4.3: Build Scraped Context Preview UI
- [ ] **Status**: Not started
- **Description**: Create UI to display scraped website context for user confirmation
- **Files**:
  - `apps/web/app/(org)/dashboard/auto-mode/components/ScrapedContextPreview.tsx` (create)
- **Acceptance Criteria**:
  - Shows website title, description, and structure
  - Displays found navigation and interactive elements
  - Loading state while scraping
  - Error state with retry option
  - User can confirm or re-scrape
- **Notes**: (to be added during implementation)

---

## Phase 5: AI Plan Generation

### Task 5.1: Design Plan Generation Prompt Engineering
- [ ] **Status**: Not started
- **Description**: Design the AI prompts for generating recording plans
- **Files**:
  - `apps/web/lib/auto-mode/prompts.ts` (create)
- **Prompt Strategy**:
  - System prompt establishing AI as a "video choreographer"
  - Include user's questionnaire answers
  - Include scraped website context (if available)
  - Request structured JSON output
- **Output Schema**:
  ```typescript
  interface GeneratedPlan {
    title: string;
    summary: string;
    estimatedDuration: number; // seconds
    narration: NarrationSegment[];
    actions: AutoModeAction[];
    warnings: string[]; // potential issues
  }

  interface NarrationSegment {
    id: string;
    text: string;
    startTime: number; // relative seconds
    duration: number;
    emotion: 'neutral' | 'excited' | 'calm' | 'serious';
  }

  interface AutoModeAction {
    id: string;
    type: 'navigate' | 'click' | 'type' | 'scroll' | 'wait' | 'hover' | 'screenshot';
    selector?: string;
    value?: string;
    duration?: number;
    description: string;
    narrationId?: string; // sync with narration
  }
  ```
- **Acceptance Criteria**:
  - Prompts produce consistent, parseable output
  - Actions are executable (valid selectors, reasonable timing)
  - Narration syncs with actions
- **Notes**: (to be added during implementation)

### Task 5.2: Implement Plan Generation Server Action
- [ ] **Status**: Not started
- **Description**: Create Server Action that calls AI to generate the recording plan
- **Files**:
  - `apps/web/actions/auto-mode/generate-plan.ts` (create)
- **Implementation**:
  - Use Groq (primary) with OpenAI fallback
  - Parse and validate AI response
  - Store plan in database
  - Update session status
- **Acceptance Criteria**:
  - Generates valid plan from questionnaire + context
  - Handles AI errors gracefully
  - Stores plan in session record
  - Returns plan for preview
- **Pattern Reference**: Follow `apps/web/actions/videos/generate-ai-metadata.ts`
- **Notes**: (to be added during implementation)

### Task 5.3: Build Plan Preview & Editor UI
- [ ] **Status**: Not started
- **Description**: Create UI for users to review and optionally edit the generated plan
- **Files**:
  - `apps/web/app/(org)/dashboard/auto-mode/components/PlanPreview/PlanPreviewContainer.tsx` (create)
  - `apps/web/app/(org)/dashboard/auto-mode/components/PlanPreview/NarrationTimeline.tsx` (create)
  - `apps/web/app/(org)/dashboard/auto-mode/components/PlanPreview/ActionsList.tsx` (create)
  - `apps/web/app/(org)/dashboard/auto-mode/components/PlanPreview/ActionEditor.tsx` (create)
  - `apps/web/app/(org)/dashboard/auto-mode/components/PlanPreview/index.ts` (create)
- **Acceptance Criteria**:
  - Displays narration script with timing
  - Shows action sequence visually
  - Allows editing narration text
  - Allows reordering/removing actions
  - "Regenerate" button for new plan
  - "Execute" button to start recording
- **Notes**: (to be added during implementation)

---

## Phase 6: TTS (Text-to-Speech) Integration

### Task 6.1: Research and Select TTS Provider
- [ ] **Status**: Not started
- **Description**: Evaluate TTS options and select the best provider
- **Options**:
  1. **ElevenLabs** - High quality, natural voices, expensive
  2. **OpenAI TTS** - Good quality, simpler API, reasonable cost
  3. **Azure Cognitive Services** - Enterprise-grade, many voices
  4. **Google Cloud TTS** - Good quality, many languages
  5. **Deepgram Aura** - Newer option, good for real-time
- **Evaluation Criteria**:
  - Voice quality and naturalness
  - Cost per character/minute
  - API simplicity
  - Voice customization options
  - Latency
- **Acceptance Criteria**:
  - Provider selected and documented
  - API keys/setup documented
  - Cost estimate for typical usage
- **Notes**: (to be added during implementation)

### Task 6.2: Implement TTS Service
- [ ] **Status**: Not started
- **Description**: Build the TTS integration service
- **Files**:
  - `apps/web/lib/auto-mode/tts/TTSService.ts` (create)
  - `apps/web/lib/auto-mode/tts/types.ts` (create)
  - `apps/web/lib/auto-mode/tts/index.ts` (create)
- **Implementation**:
  ```typescript
  interface TTSService {
    generateAudio(segments: NarrationSegment[]): Promise<TTSResult>;
  }

  interface TTSResult {
    audioUrl: string;
    duration: number;
    segments: { id: string; startTime: number; endTime: number }[];
  }
  ```
- **Acceptance Criteria**:
  - Generates audio from narration segments
  - Uploads audio to S3
  - Returns timing information for sync
  - Handles errors gracefully
- **Notes**: (to be added during implementation)

### Task 6.3: Add TTS Server Action
- [ ] **Status**: Not started
- **Description**: Create Server Action for TTS generation
- **Files**:
  - `apps/web/actions/auto-mode/generate-narration.ts` (create)
- **Acceptance Criteria**:
  - Accepts session ID with plan
  - Generates audio for all narration segments
  - Stores audio URL in session
  - Updates session status
- **Notes**: (to be added during implementation)

---

## Phase 7: Browser Automation Engine

### Task 7.1: Set Up Playwright Infrastructure
- [ ] **Status**: Not started
- **Description**: Set up Playwright for server-side browser automation
- **Files**:
  - `packages/auto-mode-engine/package.json` (create new package)
  - `packages/auto-mode-engine/src/index.ts` (create)
  - `packages/auto-mode-engine/src/BrowserPool.ts` (create)
  - Update root `package.json` and `pnpm-workspace.yaml`
- **Considerations**:
  - Browser binary installation
  - Resource pooling for concurrent executions
  - Timeout and error handling
  - Cleanup on failure
- **Acceptance Criteria**:
  - Playwright package installed and configured
  - Browser pool for managing instances
  - Basic navigation test passing
- **Notes**: (to be added during implementation)

### Task 7.2: Implement Action Executor
- [ ] **Status**: Not started
- **Description**: Build the engine that executes generated actions in the browser
- **Files**:
  - `packages/auto-mode-engine/src/ActionExecutor.ts` (create)
  - `packages/auto-mode-engine/src/actions/navigate.ts` (create)
  - `packages/auto-mode-engine/src/actions/click.ts` (create)
  - `packages/auto-mode-engine/src/actions/type.ts` (create)
  - `packages/auto-mode-engine/src/actions/scroll.ts` (create)
  - `packages/auto-mode-engine/src/actions/wait.ts` (create)
  - `packages/auto-mode-engine/src/actions/hover.ts` (create)
  - `packages/auto-mode-engine/src/actions/index.ts` (create)
- **Implementation**:
  ```typescript
  class ActionExecutor {
    constructor(page: Page, plan: GeneratedPlan);
    async execute(): AsyncGenerator<ExecutionEvent>;
  }

  interface ExecutionEvent {
    type: 'action_start' | 'action_complete' | 'action_error' | 'execution_complete';
    actionId?: string;
    timestamp: number;
    details?: any;
  }
  ```
- **Acceptance Criteria**:
  - Executes all action types correctly
  - Handles missing elements gracefully
  - Waits for page loads
  - Reports progress via events
  - Supports abort/cancel
- **Notes**: (to be added during implementation)

### Task 7.3: Implement Browser Recording
- [ ] **Status**: Not started
- **Description**: Record the browser session as video
- **Files**:
  - `packages/auto-mode-engine/src/BrowserRecorder.ts` (create)
- **Options**:
  1. **Playwright Video** - Built-in `page.video()` - Simple but limited control
  2. **CDP Screencast** - Chrome DevTools Protocol - More control, complex
  3. **FFmpeg + Screenshots** - Manual approach - Full control, more work
- **Acceptance Criteria**:
  - Records browser viewport as video
  - Configurable resolution and framerate
  - Outputs MP4 format
  - Handles long recordings (memory management)
- **Notes**: (to be added during implementation)

### Task 7.4: Handle Edge Cases and Resilience
- [ ] **Status**: Not started
- **Description**: Add robust error handling for common browser automation issues
- **Files**:
  - `packages/auto-mode-engine/src/ErrorHandler.ts` (create)
  - `packages/auto-mode-engine/src/Retrier.ts` (create)
- **Edge Cases to Handle**:
  - Element not found / selector invalid
  - Page navigation interrupts
  - Popup/modal blocking
  - Cookie consent dialogs
  - Login walls
  - Rate limiting / captchas
  - Network failures
  - Timeout handling
- **Acceptance Criteria**:
  - Each edge case has a handling strategy
  - Retries with exponential backoff where appropriate
  - Clear error messages for user feedback
  - Graceful degradation (partial success)
- **Notes**: (to be added during implementation)

---

## Phase 8: Execution Orchestration

### Task 8.1: Design Execution Workflow
- [ ] **Status**: Not started
- **Description**: Design the workflow that orchestrates the full execution pipeline
- **Files**:
  - `apps/web/workflows/auto-mode-execute.ts` (create)
- **Workflow Steps**:
  1. Load session and plan from database
  2. Initialize browser with target URL
  3. Start recording
  4. Execute actions with timing
  5. Stop recording
  6. Generate TTS audio (if not pre-generated)
  7. Merge video and audio
  8. Apply background/styling
  9. Upload final video
  10. Create video record in database
  11. Update session status
- **Acceptance Criteria**:
  - Uses `"use workflow"` and `"use step"` directives
  - Each step is atomic and resumable
  - Progress is trackable
  - Errors are handled per-step
- **Pattern Reference**: Follow `apps/web/workflows/transcribe.ts`
- **Notes**: (to be added during implementation)

### Task 8.2: Implement Execution Server Action
- [ ] **Status**: Not started
- **Description**: Create Server Action to trigger execution workflow
- **Files**:
  - `apps/web/actions/auto-mode/start-execution.ts` (create)
- **Acceptance Criteria**:
  - Validates session is ready for execution
  - Triggers workflow
  - Returns execution ID for tracking
  - Updates session status to "executing"
- **Notes**: (to be added during implementation)

### Task 8.3: Build Execution Progress UI
- [ ] **Status**: Not started
- **Description**: Create real-time progress UI during execution
- **Files**:
  - `apps/web/app/(org)/dashboard/auto-mode/components/ExecutionProgress/ExecutionProgressContainer.tsx` (create)
  - `apps/web/app/(org)/dashboard/auto-mode/components/ExecutionProgress/ProgressSteps.tsx` (create)
  - `apps/web/app/(org)/dashboard/auto-mode/components/ExecutionProgress/LivePreview.tsx` (create) [stretch goal]
  - `apps/web/app/(org)/dashboard/auto-mode/components/ExecutionProgress/index.ts` (create)
- **Acceptance Criteria**:
  - Shows current execution step
  - Progress bar for overall progress
  - Estimated time remaining
  - Cancel button
  - Error state with details
- **Notes**: (to be added during implementation)

---

## Phase 9: Video Processing & Assembly

### Task 9.1: Implement Audio-Video Merger
- [ ] **Status**: Not started
- **Description**: Merge the browser recording with TTS narration audio
- **Files**:
  - `apps/web/lib/auto-mode/video/AudioVideoMerger.ts` (create)
- **Implementation**:
  - Use FFmpeg for merging
  - Handle timing/sync based on narration segments
  - Mix narration volume appropriately
- **Acceptance Criteria**:
  - Merges video and audio correctly
  - Audio syncs with video timing
  - Output is valid MP4
- **Notes**: (to be added during implementation)

### Task 9.2: Implement Background/Styling Layer
- [ ] **Status**: Not started
- **Description**: Add polished background and styling to the recording
- **Files**:
  - `apps/web/lib/auto-mode/video/BackgroundApplier.ts` (create)
  - `apps/web/lib/auto-mode/video/templates/` (create directory for templates)
- **Background Options** (v1 - simple):
  - Solid color gradient background
  - Browser mockup frame
  - Subtle shadow/glow effects
  - (Future: animated backgrounds, custom branding)
- **Acceptance Criteria**:
  - Applies background template to video
  - Browser content centered/scaled appropriately
  - Professional-looking output
- **Notes**: (to be added during implementation)

### Task 9.3: Implement Final Video Upload
- [ ] **Status**: Not started
- **Description**: Upload the final processed video to S3 and create video record
- **Files**:
  - `apps/web/lib/auto-mode/video/FinalVideoUploader.ts` (create)
- **Acceptance Criteria**:
  - Uploads video to S3 with correct path
  - Creates video record in database
  - Links to auto mode session
  - Triggers transcription workflow
  - Generates thumbnail
- **Pattern Reference**: Follow `apps/web/actions/video/upload.ts`
- **Notes**: (to be added during implementation)

---

## Phase 10: Integration & User Flow

### Task 10.1: Implement Complete User Flow State Machine
- [ ] **Status**: Not started
- **Description**: Create unified state machine for the entire Auto Mode user flow
- **Files**:
  - `apps/web/app/(org)/dashboard/auto-mode/hooks/useAutoModeFlow.ts` (create)
- **States**:
  1. `prompt` - Initial prompt input
  2. `questionnaire` - Multi-step questionnaire
  3. `scraping` - Website scraping (if URL provided)
  4. `generating` - AI plan generation
  5. `preview` - Plan preview and editing
  6. `tts` - TTS generation (can be parallel)
  7. `executing` - Browser automation running
  8. `processing` - Video processing
  9. `complete` - Success, show result
  10. `error` - Failure state
- **Acceptance Criteria**:
  - Smooth transitions between all states
  - State persisted to database session
  - Resumable from any state (page refresh)
  - Back navigation where appropriate
- **Notes**: (to be added during implementation)

### Task 10.2: Connect All Components
- [ ] **Status**: Not started
- **Description**: Wire up all components into the main AutoMode page
- **Files**:
  - `apps/web/app/(org)/dashboard/auto-mode/AutoMode.tsx` (modify)
  - `apps/web/app/(org)/dashboard/auto-mode/page.tsx` (modify)
- **Acceptance Criteria**:
  - All components render in correct flow states
  - Data flows correctly between components
  - Error boundaries in place
  - Performance is acceptable
- **Notes**: (to be added during implementation)

### Task 10.3: Add Result Display and Sharing
- [ ] **Status**: Not started
- **Description**: Show the completed video and sharing options
- **Files**:
  - `apps/web/app/(org)/dashboard/auto-mode/components/ResultDisplay.tsx` (create)
- **Acceptance Criteria**:
  - Video player shows completed video
  - Share button copies link
  - "Create Another" button resets flow
  - Video appears in user's Caps library
- **Notes**: (to be added during implementation)

---

## Phase 11: Polish & Error Handling

### Task 11.1: Add Comprehensive Loading States
- [ ] **Status**: Not started
- **Description**: Ensure all async operations have proper loading states
- **Files**:
  - Various component files (review and update)
- **Acceptance Criteria**:
  - Every async operation shows loading indicator
  - Skeleton loaders where appropriate
  - No layout shift during loading
- **Notes**: (to be added during implementation)

### Task 11.2: Implement Error Recovery
- [ ] **Status**: Not started
- **Description**: Add retry logic and error recovery throughout the flow
- **Files**:
  - Various action and component files (review and update)
- **Acceptance Criteria**:
  - Failed scraping can be retried
  - Failed plan generation can be retried
  - Failed execution shows clear error and allows restart
  - Partial failures handled gracefully
- **Notes**: (to be added during implementation)

### Task 11.3: Add Usage Limits and Rate Limiting
- [ ] **Status**: Not started
- **Description**: Implement usage limits for free vs pro users
- **Files**:
  - `apps/web/lib/auto-mode/UsageLimits.ts` (create)
  - Modify relevant Server Actions
- **Limits to Consider**:
  - Executions per day/month
  - Video duration limits
  - Concurrent executions
  - Storage limits
- **Acceptance Criteria**:
  - Free users have appropriate limits
  - Clear messaging when limits reached
  - Upgrade prompts where appropriate
- **Notes**: (to be added during implementation)

### Task 11.4: Add Analytics and Tracking
- [ ] **Status**: Not started
- **Description**: Track Auto Mode usage for analytics
- **Files**:
  - `apps/web/actions/analytics/track-auto-mode.ts` (create)
- **Events to Track**:
  - Session started
  - Questionnaire completed
  - Plan generated
  - Execution started/completed/failed
  - Video shared
- **Acceptance Criteria**:
  - Events sent to PostHog
  - Useful for understanding feature usage
  - No PII in events
- **Notes**: (to be added during implementation)

---

## Phase 12: Testing & Documentation

### Task 12.1: Add Unit Tests for Core Logic
- [ ] **Status**: Not started
- **Description**: Write unit tests for critical business logic
- **Files**:
  - `packages/auto-mode-engine/src/__tests__/ActionExecutor.test.ts` (create)
  - `apps/web/lib/auto-mode/__tests__/prompts.test.ts` (create)
- **Acceptance Criteria**:
  - Action executor tested
  - Prompt generation tested
  - Plan parsing tested
- **Notes**: (to be added during implementation)

### Task 12.2: Add Integration Tests
- [ ] **Status**: Not started
- **Description**: Write integration tests for the full flow
- **Files**:
  - `apps/web/__tests__/auto-mode/integration.test.ts` (create)
- **Acceptance Criteria**:
  - End-to-end flow tested (mocked browser)
  - Server Actions tested
  - Database operations tested
- **Notes**: (to be added during implementation)

### Task 12.3: Write User Documentation
- [ ] **Status**: Not started
- **Description**: Create user-facing documentation for Auto Mode
- **Files**:
  - Documentation in appropriate location (docs site or in-app help)
- **Acceptance Criteria**:
  - Feature overview
  - Step-by-step guide
  - Tips for best results
  - Troubleshooting section
- **Notes**: (to be added during implementation)

---

## Infrastructure Considerations

### Headless Browser Hosting

Options to evaluate:
1. **Same Server** - Run Playwright on web server (simple but resource-intensive)
2. **Separate Service** - Dedicated browser automation service
3. **Serverless** - AWS Lambda with Playwright layers, Browserless.io, etc.
4. **Container** - Docker container with browser, scaled as needed

Recommendation: Start with separate service using Docker containers, scale based on demand.

### Video Processing

Options:
1. **Server-side FFmpeg** - Direct FFmpeg calls on server
2. **AWS MediaConvert** - Managed video processing
3. **Cloudflare Stream** - Managed video with processing
4. **Custom Workers** - Dedicated video processing workers

Recommendation: Start with server-side FFmpeg, consider managed services for scale.

---

## Learning Log

| Date | Learning | Impact |
|------|----------|--------|
| (learnings will be logged here as implementation progresses) | | |

---

## Dependencies

### New NPM Packages Likely Needed

- `playwright` - Browser automation
- TTS SDK (depending on provider selection)
- `fluent-ffmpeg` or similar - Video processing wrapper

### Environment Variables to Add

- `TTS_API_KEY` - For chosen TTS provider
- `AUTO_MODE_BROWSER_POOL_SIZE` - Browser instance limit
- `AUTO_MODE_MAX_DURATION` - Maximum recording duration

---

## Estimated Effort

| Phase | Estimated Tasks | Complexity |
|-------|-----------------|------------|
| Phase 1: Foundation | 3 tasks | Low |
| Phase 2: Database | 3 tasks | Low |
| Phase 3: Questionnaire | 3 tasks | Medium |
| Phase 4: Scraping | 3 tasks | Medium |
| Phase 5: Plan Generation | 3 tasks | Medium-High |
| Phase 6: TTS | 3 tasks | Medium |
| Phase 7: Browser Automation | 4 tasks | High |
| Phase 8: Orchestration | 3 tasks | High |
| Phase 9: Video Processing | 3 tasks | High |
| Phase 10: Integration | 3 tasks | Medium |
| Phase 11: Polish | 4 tasks | Medium |
| Phase 12: Testing | 3 tasks | Medium |

**Total: 38 tasks**

---

## Success Metrics

1. **Functional**: Users can describe a recording and get a polished video output
2. **Quality**: Generated videos look professional and narration syncs correctly
3. **Reliability**: >95% of executions complete successfully
4. **Performance**: Average execution time <5 minutes for a 1-minute video
5. **Adoption**: Track usage and user feedback

---

## Future Enhancements (Post-v1)

1. **Custom branding** - User's logo, colors in background
2. **Voice cloning** - Use user's voice for narration
3. **Interactive editing** - Click to re-record specific segments
4. **Templates** - Pre-built recording templates for common use cases
5. **Scheduling** - Schedule recordings to run at specific times
6. **Multi-page flows** - Complex user journeys across multiple pages
7. **A/B variations** - Generate multiple versions of the same recording
