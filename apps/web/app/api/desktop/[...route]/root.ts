import { db } from "@cap/database";
import { organizations, users } from "@cap/database/schema";
import { buildEnv, serverEnv } from "@cap/env";
import { isUserOnProPlan, stripe } from "@cap/utils";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import * as crypto from "node:crypto";
import { PostHog } from "posthog-node";
import { z } from "zod";
import { withAuth } from "../../utils";
import { createBucketProvider } from "@/utils/s3";

export const app = new Hono().use(withAuth);

app.post(
  "/feedback",
  zValidator(
    "form",
    z.object({
      feedback: z.string(),
      os: z.union([z.literal("macos"), z.literal("windows")]).optional(),
      version: z.string().optional(),
    })
  ),
  async (c) => {
    const { feedback, os, version } = c.req.valid("form");

    try {
      const discordWebhookUrl = serverEnv().DISCORD_FEEDBACK_WEBHOOK_URL;
      if (!discordWebhookUrl)
        throw new Error("Discord webhook URL is not configured");

      const response = await fetch(discordWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: [
            `New feedback from ${c.get("user").email}:`,
            feedback,
            os && version && `${os} v${version}`,
          ]
            .filter(Boolean)
            .join("\n"),
        }),
      });

      if (!response.ok)
        throw new Error(
          `Failed to send feedback to Discord: ${response.statusText}`
        );

      return c.json({
        success: true,
        message: "Feedback submitted successfully",
      });
    } catch (error) {
      return c.json({ error: "Failed to submit feedback" }, { status: 500 });
    }
  }
);

app.post(
  "/diagnostics",
  async (c) => {
    console.log("Diagnostics endpoint called");
    
    // Manually parse and validate the request
    let body;
    try {
      body = await c.req.json();
      console.log("Request body:", JSON.stringify(body, null, 2));
    } catch (e) {
      console.error("Failed to parse JSON:", e);
      return c.json({ error: "Invalid JSON" }, { status: 400 });
    }
    
    // Validate the body structure
    const schema = z.object({
      diagnostics: z.any(),
      description: z.string().nullable().optional(),
      includeErrors: z.boolean().default(false),
    });
    
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      console.error("Validation error:", parsed.error);
      return c.json({ error: "Invalid request data", details: parsed.error }, { status: 400 });
    }
    
    const { diagnostics, description, includeErrors } = parsed.data;
    const user = c.get("user");

    console.log("Parsed diagnostics:", diagnostics);
    console.log("User:", user?.email);

    try {
      const discordWebhookUrl = serverEnv().DISCORD_FEEDBACK_WEBHOOK_URL;
      if (!discordWebhookUrl)
        throw new Error("Discord webhook URL is not configured");

      // Format diagnostics for Discord with all the enhanced details
      let summary = "**Device Diagnostics Report**\n";
      
      if (diagnostics) {
        // System Info
        summary += `\n**System Information:**\n`;
        summary += `• OS: ${diagnostics.os?.name || 'Unknown'} ${diagnostics.os?.version || ''} (${diagnostics.os?.arch || ''})\n`;
        summary += `• CPU: ${diagnostics.hardware?.cpu_model || 'Unknown CPU'} (${diagnostics.hardware?.cpu_cores || '?'} cores)\n`;
        summary += `• Memory: ${diagnostics.hardware?.total_memory_gb?.toFixed(1) || '?'}GB total, ${diagnostics.hardware?.available_memory_gb?.toFixed(1) || '?'}GB available\n`;
        
        // GPU Info
        if (diagnostics.hardware?.gpu_info?.length > 0) {
          summary += `\n**Graphics:**\n`;
          diagnostics.hardware.gpu_info.forEach((gpu: any) => {
            summary += `• ${gpu.name} (${gpu.vendor})`;
            if (gpu.vram_mb) summary += ` - ${gpu.vram_mb}MB VRAM`;
            if (gpu.driver_version) summary += ` - Driver: ${gpu.driver_version}`;
            summary += '\n';
          });
        }
        
        // Displays
        if (diagnostics.displays?.length > 0) {
          summary += `\n**Displays (${diagnostics.displays.length}):**\n`;
          diagnostics.displays.forEach((display: any) => {
            summary += `• ${display.name}: ${display.resolution[0]}×${display.resolution[1]} @ ${display.refresh_rate}Hz`;
            if (display.scale_factor && display.scale_factor !== 1) {
              summary += ` (${display.scale_factor}x scale)`;
            }
            if (display.is_primary) summary += ' [Primary]';
            summary += '\n';
          });
        }
        
        // Video Devices
        if (diagnostics.video_devices?.length > 0) {
          summary += `\n**Cameras (${diagnostics.video_devices.length}):**\n`;
          diagnostics.video_devices.forEach((device: any) => {
            summary += `• ${device.name}`;
            if (device.is_virtual) summary += ' [Virtual]';
            summary += ` (${device.backend})\n`;
            if (device.supported_formats?.length > 0) {
              const format = device.supported_formats[0];
              summary += `  → Best format: ${format.width}×${format.height} @ ${format.fps}fps (${format.format})\n`;
              if (device.supported_formats.length > 1) {
                summary += `  → ${device.supported_formats.length - 1} other formats available\n`;
              }
            }
          });
        }
        
        // Audio Devices
        if (diagnostics.audio_devices?.input_devices?.length > 0) {
          summary += `\n**Audio Input Devices (${diagnostics.audio_devices.input_devices.length}):**\n`;
          diagnostics.audio_devices.input_devices.forEach((device: any) => {
            summary += `• ${device.name}`;
            if (device.is_default) summary += ' [Default]';
            summary += '\n';
            if (device.sample_rates?.length > 0) {
              const rates = device.sample_rates.map((r: number) => `${r/1000}kHz`).join(', ');
              summary += `  → Sample rates: ${rates}\n`;
            }
            if (device.channels) {
              summary += `  → Channels: ${device.channels}\n`;
            }
          });
        }
        
        // Capture Capabilities
        if (diagnostics.capture_capabilities) {
          summary += `\n**Capture Capabilities:**\n`;
          summary += `• API: ${diagnostics.capture_capabilities.screen_capture_api}\n`;
          if (diagnostics.capture_capabilities.hardware_encoder) {
            summary += `• Hardware Encoder: ${diagnostics.capture_capabilities.hardware_encoder}\n`;
          }
          summary += `• Hardware Encoding: ${diagnostics.capture_capabilities.supports_hardware_encoding ? 'Yes' : 'No'}\n`;
          if (diagnostics.capture_capabilities.supported_codecs?.length > 0) {
            summary += `• Codecs: ${diagnostics.capture_capabilities.supported_codecs.join(', ')}\n`;
          }
        }
        
        // FFmpeg Info
        if (diagnostics.ffmpeg_info) {
          summary += `\n**FFmpeg:**\n`;
          summary += `• Version: ${diagnostics.ffmpeg_info.version}\n`;
          if (diagnostics.ffmpeg_info.hardware_acceleration?.length > 0) {
            summary += `• Hardware Acceleration: ${diagnostics.ffmpeg_info.hardware_acceleration.join(', ')}\n`;
          }
        }
        
        // Performance Hints
        if (diagnostics.performance_hints?.length > 0) {
          summary += `\n**Performance Hints:**\n`;
          diagnostics.performance_hints.forEach((hint: string) => {
            summary += `⚠️ ${hint}\n`;
          });
        }
      } else {
        summary += 'No diagnostics data provided';
      }

      // Truncate if too long for Discord (2000 char limit per field)
      if (summary.length > 1900) {
        summary = summary.substring(0, 1900) + '...\n[Truncated]';
      }

      const response = await fetch(discordWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `**Device Diagnostics Report** from ${user.email}`,
          embeds: [{
            title: "System Diagnostics",
            description: summary,
            color: 0x007AFF,
            timestamp: new Date().toISOString(),
            footer: {
              text: description || "No description provided"
            },
            fields: includeErrors ? [{
              name: "Errors Included",
              value: "Yes - Check thread for error logs",
              inline: true
            }] : []
          }]
        }),
      });

      if (!response.ok)
        throw new Error(
          `Failed to send diagnostics to Discord: ${response.statusText}`
        );

      return c.json({
        success: true,
        message: "Diagnostics submitted successfully",
        profileId: crypto.randomUUID(), // Generate a unique ID for reference
      });
    } catch (error) {
      console.error("Failed to submit diagnostics:", error);
      return c.json({ error: "Failed to submit diagnostics" }, { status: 500 });
    }
  }
);

app.get("/org-custom-domain", async (c) => {
  const user = c.get("user");

  try {
    const [result] = await db()
      .select({
        customDomain: organizations.customDomain,
        domainVerified: organizations.domainVerified,
      })
      .from(users)
      .leftJoin(organizations, eq(users.activeOrganizationId, organizations.id))
      .where(eq(users.id, user.id));

    // Ensure custom domain has https:// prefix
    let customDomain = result?.customDomain ?? null;
    if (
      customDomain &&
      !customDomain.startsWith("http://") &&
      !customDomain.startsWith("https://")
    ) {
      customDomain = `https://${customDomain}`;
    }

    return c.json({
      custom_domain: customDomain,
      domain_verified: result?.domainVerified ?? null,
    });
  } catch (error) {
    console.error("[GET] Error fetching custom domain:", error);
    return c.json({ error: "Failed to fetch custom domain" }, { status: 500 });
  }
});

app.get("/plan", async (c) => {
  const user = c.get("user");

  let isSubscribed = isUserOnProPlan({
    subscriptionStatus: user.stripeSubscriptionStatus,
  });

  if (user.thirdPartyStripeSubscriptionId) {
    isSubscribed = true;
  }

  if (!isSubscribed && !user.stripeSubscriptionId && user.stripeCustomerId) {
    try {
      const subscriptions = await stripe().subscriptions.list({
        customer: user.stripeCustomerId,
      });
      const activeSubscription = subscriptions.data.find(
        (sub) => sub.status === "active"
      );
      if (activeSubscription) {
        isSubscribed = true;
        await db()
          .update(users)
          .set({
            stripeSubscriptionStatus: activeSubscription.status,
            stripeSubscriptionId: activeSubscription.id,
          })
          .where(eq(users.id, user.id));
      }
    } catch (error) {
      console.error("[GET] Error fetching subscription from Stripe:", error);
    }
  }

  let intercomHash = "";
  const intercomSecret = serverEnv().INTERCOM_SECRET;
  if (intercomSecret) {
    intercomHash = crypto
      .createHmac("sha256", intercomSecret)
      .update(user?.id ?? "")
      .digest("hex");
  }

  return c.json({
    upgraded: isSubscribed,
    stripeSubscriptionStatus: user.stripeSubscriptionStatus,
    intercomHash: intercomHash,
  });
});

app.post(
  "/subscribe",
  zValidator("json", z.object({ priceId: z.string() })),
  async (c) => {
    const { priceId } = c.req.valid("json");
    const user = c.get("user");

    if (
      isUserOnProPlan({ subscriptionStatus: user.stripeSubscriptionStatus })
    ) {
      console.log("[POST] Error: User already on Pro plan");
      return c.json({ error: true, subscription: true }, { status: 400 });
    }

    let customerId = user.stripeCustomerId;

    if (user.stripeCustomerId === null) {
      console.log("[POST] Creating new Stripe customer");
      const customer = await stripe().customers.create({
        email: user.email,
        metadata: { userId: user.id },
      });

      await db()
        .update(users)
        .set({ stripeCustomerId: customer.id })
        .where(eq(users.id, user.id));

      customerId = customer.id;
      console.log("[POST] Created Stripe customer:", customerId);
    }

    console.log("[POST] Creating checkout session");
    const checkoutSession = await stripe().checkout.sessions.create({
      customer: customerId as string,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: "subscription",
      success_url: `${serverEnv().WEB_URL}/dashboard/caps?upgrade=true`,
      cancel_url: `${serverEnv().WEB_URL}/pricing`,
      allow_promotion_codes: true,
      metadata: { platform: "desktop" },
    });

    if (checkoutSession.url) {
      console.log("[POST] Checkout session created successfully");

      try {
        const ph = new PostHog(buildEnv.NEXT_PUBLIC_POSTHOG_KEY || "", {
          host: buildEnv.NEXT_PUBLIC_POSTHOG_HOST || "",
        });

        ph.capture({
          distinctId: user.id,
          event: "checkout_started",
          properties: {
            price_id: priceId,
            quantity: 1,
            platform: "desktop",
          },
        });

        await ph.shutdown();
      } catch (e) {
        console.error("Failed to capture checkout_started in PostHog", e);
      }

      return c.json({ url: checkoutSession.url });
    }

    console.log("[POST] Error: Failed to create checkout session");
    return c.json({ error: true }, { status: 400 });
  }
);

app.post(
  "/notify-bundle-upload",
  zValidator(
    "json",
    z.object({
      bundleUrl: z.string(),
      bundleName: z.string(),
      recordingName: z.string(),
      userEmail: z.string(),
    })
  ),
  async (c) => {
    const { bundleUrl, bundleName, recordingName, userEmail } = c.req.valid("json");

    try {
      const discordWebhookUrl = serverEnv().DISCORD_FEEDBACK_WEBHOOK_URL;
      if (!discordWebhookUrl)
        throw new Error("Discord webhook URL is not configured");

      const response = await fetch(discordWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          embeds: [{
            title: "Recording Bundle Uploaded",
            description: `A user has uploaded a recording bundle for support`,
            color: 0x007AFF,
            fields: [
              {
                name: "User",
                value: userEmail,
                inline: true
              },
              {
                name: "Recording",
                value: recordingName,
                inline: true
              },
              {
                name: "Bundle Name",
                value: bundleName,
                inline: false
              },
              {
                name: "Download URL",
                value: bundleUrl,
                inline: false
              }
            ],
            timestamp: new Date().toISOString()
          }]
        }),
      });

      if (!response.ok)
        throw new Error(
          `Failed to send notification to Discord: ${response.statusText}`
        );

      return c.json({
        success: true,
        message: "Notification sent successfully",
      });
    } catch (error) {
      console.error("Failed to send Discord notification:", error);
      return c.json({ error: "Failed to send notification" }, { status: 500 });
    }
  }
);

app.get(
  "/download-bundle/:key",
  async (c) => {
    const key = c.req.param("key");
    
    try {
      const bucket = await createBucketProvider();
      const signedUrl = await bucket.getSignedObjectUrl(key);
      
      return c.redirect(signedUrl);
    } catch (error) {
      console.error("Failed to get download URL:", error);
      return c.json({ error: "Failed to get download URL" }, { status: 500 });
    }
  }
);

export default app;
