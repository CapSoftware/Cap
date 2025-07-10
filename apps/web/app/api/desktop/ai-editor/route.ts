import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

// Define the configuration schema based on the ProjectConfiguration type
const ProjectConfigSchema = z.object({
  aspectRatio: z.enum(["wide", "vertical", "square", "classic", "tall"]).nullable(),
  background: z.object({
    source: z.union([
      z.object({ type: z.literal("wallpaper"), path: z.string().nullable() }),
      z.object({ type: z.literal("image"), path: z.string().nullable() }),
      z.object({ type: z.literal("color"), value: z.tuple([z.number(), z.number(), z.number()]) }),
      z.object({ 
        type: z.literal("gradient"), 
        from: z.tuple([z.number(), z.number(), z.number()]),
        to: z.tuple([z.number(), z.number(), z.number()]),
        angle: z.number().optional()
      }),
    ]),
    blur: z.number(),
    padding: z.number(),
    rounding: z.number(),
    inset: z.number(),
    crop: z.object({
      position: z.object({ x: z.number(), y: z.number() }),
      size: z.object({ x: z.number(), y: z.number() }),
    }).nullable(),
    shadow: z.number().optional(),
    advancedShadow: z.object({
      size: z.number(),
      opacity: z.number(),
      blur: z.number(),
    }).nullable().optional(),
  }),
  camera: z.object({
    hide: z.boolean(),
    mirror: z.boolean(),
    position: z.object({ x: z.string(), y: z.string() }),
    size: z.number(),
    zoom_size: z.number().nullable(),
    rounding: z.number().optional(),
    shadow: z.number().optional(),
    advanced_shadow: z.object({
      size: z.number(),
      opacity: z.number(),
      blur: z.number(),
    }).nullable().optional(),
    shape: z.enum(["square", "source"]).optional(),
  }),
  audio: z.object({
    mute: z.boolean(),
    improve: z.boolean(),
    micVolumeDb: z.number().optional(),
    micStereoMode: z.enum(["stereo", "monoL", "monoR"]).optional(),
    systemVolumeDb: z.number().optional(),
  }),
  cursor: z.object({
    hide: z.boolean().optional(),
    hideWhenIdle: z.boolean(),
    size: z.number(),
    type: z.string(),
    animationStyle: z.string(),
    tension: z.number(),
    mass: z.number(),
    friction: z.number(),
    raw: z.boolean().optional(),
    motionBlur: z.number().optional(),
  }),
  hotkeys: z.object({
    show: z.boolean(),
  }),
  timeline: z.any().optional(),
  captions: z.any().optional(),
});

const RequestSchema = z.object({
  prompt: z.string(),
  currentConfig: ProjectConfigSchema,
  editorContext: z.object({
    hasCamera: z.boolean(),
    hasAudio: z.boolean(),
    hasCursor: z.boolean(),
    duration: z.number(),
  }),
  conversationHistory: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  })),
  availableBackgrounds: z.object({
    wallpapers: z.array(z.string()),
    colors: z.array(z.string()),
    gradients: z.array(z.object({
      from: z.tuple([z.number(), z.number(), z.number()]),
      to: z.tuple([z.number(), z.number(), z.number()]),
    })),
  }).optional(),
});

// Function to create system prompt with available backgrounds
function createSystemPrompt(availableBackgrounds?: { wallpapers: string[], colors: string[], gradients: Array<{ from: number[], to: number[] }> }) {
  let backgroundSection = `BACKGROUND:
- Source must be one of these exact structures:
  - {type: "wallpaper", path: string|null}
  - {type: "image", path: string|null}
  - {type: "color", value: [r, g, b]} where r,g,b are 0-255
  - {type: "gradient", from: [r,g,b], to: [r,g,b], angle?: number}`;

  if (availableBackgrounds) {
    backgroundSection += `\n\nAvailable preset backgrounds:`;
    
    if (availableBackgrounds.wallpapers.length > 0) {
      // Group wallpapers by theme
      const macOSWallpapers = availableBackgrounds.wallpapers.filter(w => w.startsWith('macOS/'));
      const blueWallpapers = availableBackgrounds.wallpapers.filter(w => w.startsWith('blue/'));
      const purpleWallpapers = availableBackgrounds.wallpapers.filter(w => w.startsWith('purple/'));
      const darkWallpapers = availableBackgrounds.wallpapers.filter(w => w.startsWith('dark/'));
      const orangeWallpapers = availableBackgrounds.wallpapers.filter(w => w.startsWith('orange/'));
      
      backgroundSection += `\n- Wallpapers by theme:`;
      backgroundSection += `\n  • macOS: ${macOSWallpapers.join(', ')}`;
      backgroundSection += `\n  • Blue: ${blueWallpapers.length} wallpapers (blue/1 to blue/6)`;
      backgroundSection += `\n  • Purple: ${purpleWallpapers.length} wallpapers (purple/1 to purple/6)`;
      backgroundSection += `\n  • Dark: ${darkWallpapers.length} wallpapers (dark/1 to dark/6)`;
      backgroundSection += `\n  • Orange: ${orangeWallpapers.length} wallpapers (orange/1 to orange/9)`;
      backgroundSection += `\n  When user asks for a specific background, use the exact path. Examples:`;
      backgroundSection += `\n  - "Sequoia dark" → "macOS/sequoia-dark"`;
      backgroundSection += `\n  - "Sonoma" → "macOS/sonoma-light" or ask which variant`;
      backgroundSection += `\n  - "blue background" → suggest options like "blue/1", "blue/2", etc.`;
    }
    
    if (availableBackgrounds.colors.length > 0) {
      backgroundSection += `\n- Preset colors: ${availableBackgrounds.colors.slice(0, 10).join(', ')}... (${availableBackgrounds.colors.length} total)`;
      backgroundSection += `\n  When user mentions a color by name, convert to RGB:`;
      backgroundSection += `\n  - "red" → [255, 0, 0]`;
      backgroundSection += `\n  - "blue" → [0, 0, 255] or [71, 133, 255] for lighter blue`;
      backgroundSection += `\n  - "purple" → [128, 0, 128]`;
      backgroundSection += `\n  Or use exact hex values if provided: #FF0000 → [255, 0, 0]`;
    }
    
    if (availableBackgrounds.gradients.length > 0) {
      backgroundSection += `\n- Preset gradients: ${availableBackgrounds.gradients.length} beautiful gradients`;
      backgroundSection += `\n  Popular options:`;
      backgroundSection += `\n  - Dark Blue to Teal: {from: [15, 52, 67], to: [52, 232, 158]}`;
      backgroundSection += `\n  - Purple to Red: {from: [131, 58, 180], to: [253, 29, 29]}`;
      backgroundSection += `\n  - Cyan to Purple: {from: [29, 253, 251], to: [195, 29, 253]}`;
      backgroundSection += `\n  Default angle is 90 degrees (left to right)`;
    }
  }

  backgroundSection += `\n- Blur: 0-100 (amount of background blur)
- Padding: 0-200 (space around the content)
- Rounding: 0-100 (corner radius)
- Inset: 0-100 (inner spacing)
- Shadow: 0-100 (shadow intensity)
- Crop: {position: {x: number, y: number}, size: {x: number, y: number}} or null`;

  return `You are an AI assistant for Cap, a video editor. You help users modify their video configuration by interpreting their natural language requests and returning transformed JSON configurations.

CRITICAL FORMAT REQUIREMENTS:
- aspectRatio must be one of these exact strings: "wide", "vertical", "square", "classic", "tall", or null
- NEVER return aspectRatio as an object with width/height properties
- background.source must follow the exact type structure (type + properties)
- All numeric values must be numbers, not strings

Available configuration options you can modify:

ASPECT RATIO:
- Must be one of these exact strings: "wide", "vertical", "square", "classic", "tall", or null
- "wide" = 16:9 ratio
- "vertical" = 9:16 ratio  
- "square" = 1:1 ratio
- "classic" = 4:3 ratio
- "tall" = 3:4 ratio
- null = auto (maintain original aspect ratio)

${backgroundSection}

CAMERA:
- Hide: true/false
- Mirror: true/false
- Position: {x: "left"|"center"|"right", y: "top"|"bottom"}
- Size: 0-100 (percentage of screen)
- Shape: "square" or "source"
- Rounding: 0-100 (corner radius)
- Shadow: 0-100 (shadow intensity)

AUDIO:
- Mute: true/false
- Microphone volume: -30 to 10 dB
- System audio volume: -30 to 10 dB
- Stereo mode: "stereo", "monoL", or "monoR"

CURSOR:
- Hide: true/false
- Size: 20-300 (percentage)
- Smooth movement settings: tension (1-500), friction (0-50), mass (0.1-10)
- Raw mode: true/false (disables smoothing)

When the user asks for changes:
1. Parse their request carefully
2. Only modify the specific properties they mention
3. Keep all other settings unchanged
4. Return a brief explanation of what was changed
5. Be helpful and suggest related options they might want to adjust

Examples:
- "Make the background blue" → Change background.source to {type: "color", value: [0, 100, 255]}
- "Use Sequoia dark background" → Change background.source to {type: "wallpaper", path: "macOS/sequoia-dark"}
- "Add padding around the video" → Increase background.padding value
- "Move camera to top right" → Change camera.position to {x: "right", y: "top"}
- "Change aspect ratio to square" → Change aspectRatio to "square"
- "Set 16:9 aspect ratio" → Change aspectRatio to "wide"
- "Make it vertical" → Change aspectRatio to "vertical"`;
}

async function callOpenAI(messages: Array<{ role: string; content: string }>, systemPrompt: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OpenAI API key not configured");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
      temperature: 0.7,
      max_tokens: 1000,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${error}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validation = RequestSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: "Invalid request data", details: validation.error },
        { status: 400 }
      );
    }

    const { prompt, currentConfig, editorContext, conversationHistory, availableBackgrounds } = validation.data;

    // Create system prompt with available backgrounds
    const systemPrompt = createSystemPrompt(availableBackgrounds);

    // Build the conversation for the AI
    const messages = [
      ...conversationHistory,
      {
        role: "user" as const,
        content: `Current configuration: ${JSON.stringify(currentConfig, null, 2)}

Editor context:
- Has camera: ${editorContext.hasCamera}
- Has audio: ${editorContext.hasAudio}
- Has cursor: ${editorContext.hasCursor}
- Duration: ${editorContext.duration} seconds

User request: ${prompt}

Please respond with a JSON object containing:
{
  "explanation": "Brief explanation of what was changed",
  "newConfig": <the updated configuration object>
}`,
      },
    ];

    // Call OpenAI
    const aiResponse = await callOpenAI(messages, systemPrompt);
    
    try {
      const parsed = JSON.parse(aiResponse);
      
      // Validate the new configuration
      const configValidation = ProjectConfigSchema.safeParse(parsed.newConfig);
      if (!configValidation.success) {
        console.error("Invalid configuration from AI:", configValidation.error);
        return NextResponse.json(
          { error: "AI generated invalid configuration", details: configValidation.error.format() },
          { status: 500 }
        );
      }

      return NextResponse.json({
        explanation: parsed.explanation || "Configuration updated successfully",
        newConfig: parsed.newConfig,
      });
    } catch (parseError) {
      console.error("Failed to parse AI response:", parseError);
      return NextResponse.json(
        { error: "Failed to parse AI response" },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("AI Editor API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
} 