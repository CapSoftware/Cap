export interface HeaderCopyVariants {
  1: {
    title: string;
    description: string;
  };
  2: {
    title: string;
    description: string;
  };
  3: {
    title: string;
    description: string;
  };
  default: {
    title: string;
    description: string;
  };
}

export interface HeaderCopy {
  announcement: {
    text: string;
    href: string;
  };
  variants: HeaderCopyVariants;
  cta: {
    primaryButton: string;
    secondaryButton: string;
    freeVersionText: string;
    seeOtherOptionsText: string;
  };
}

export interface RecordingModesCopy {
  title: string;
  subtitle: string;
  modes: {
    name: string;
    description: string;
  }[];
}

export interface FeaturesCopy {
  title: string;
  subtitle: string;
  features: {
    title: string;
    description: string;
  }[];
}

export interface TestimonialsCopy {
  title: string;
  subtitle: string;
  cta: string;
}

export interface PricingCopy {
  title: string;
  subtitle: string;
  lovedBy: string;
  commercial: {
    title: string;
    description: string;
    features: string[];
    cta: string;
    pricing: {
      yearly: number;
      lifetime: number;
    };
    labels: {
      licenses: string;
      yearly: string;
      lifetime: string;
    };
  };
  pro: {
    badge: string;
    title: string;
    description: string;
    features: string[];
    cta: string;
    pricing: {
      annual: number;
      monthly: number;
    };
    labels: {
      users: string;
      monthly: string;
      annually: string;
    };
  };
}

export interface FaqCopy {
  title: string;
  items: {
    question: string;
    answer: string;
  }[];
}

export interface ReadyToGetStartedCopy {
  title: string;
  buttons: {
    primary: string;
    secondary: string;
  };
}

export interface HomePageCopy {
  header: HeaderCopy;
  textReveal: string;
  recordingModes: RecordingModesCopy;
  features: FeaturesCopy;
  testimonials: TestimonialsCopy;
  pricing: PricingCopy;
  faq: FaqCopy;
  readyToGetStarted: ReadyToGetStartedCopy;
}

export const homepageCopy: HomePageCopy = {
  header: {
    announcement: {
      text: "Introducing Auto Zoom ✨",
      href: "https://x.com/richiemcilroy/status/1895526857807733018",
    },
    variants: {
      1: {
        title: "Beautiful, shareable screen recordings",
        description: "Cap is the open source Loom alternative that creators, designers, and engineers actually want to use. Open source, cross-platform, and built for how you work.",
      },
      2: {
        title: "The screen recorder that respects your workflow",
        description: "Record, edit, and share in seconds — not minutes. Cap gives you studio-quality recordings without the studio complexity. Own your content, control your data.",
      },
      3: {
        title: "Screen recording with superpowers",
        description: "Beautiful recordings in one click. Professional editing when you need it. Share instantly or polish to perfection — Cap adapts to how you work, not the other way around.",
      },
      default: {
        title: "Beautiful, shareable screen recordings",
        description: "Cap is the open source Loom alternative that creators, designers, and engineers actually want to use. Open source, cross-platform, and built for how you work.",
      },
    },
    cta: {
      primaryButton: "Start for free",
      secondaryButton: "Download", // Dynamic based on platform
      freeVersionText: "No credit card required",
      seeOtherOptionsText: "See pricing",
    },
  },
  textReveal: "Record. Edit. Share.",
  recordingModes: {
    title: "Two modes. Zero compromises.",
    subtitle: "Instant Mode bypasses rendering with real-time uploading whilst you are recording. Studio Mode prioritizes quality with local recording and full editing capabilities.",
    modes: [
      {
        name: "Instant Mode",
        description: "Hit record, stop, share link. Your video is live in seconds with automatic optimizations. Perfect for quick feedback, bug reports, or when you just need to show something fast.",
      },
      {
        name: "Studio Mode",
        description: "Professional recordings with local editing, custom backgrounds, and export options. When you need pixel-perfect demos, tutorials, or presentations that represent your brand.",
      },
    ],
  },
  features: {
    title: "Built for how you actually work",
    subtitle: "We obsessed over the details so you don't have to. Every feature is designed to save you time and make you look good.",
    features: [
      {
        title: "Your storage, your rules",
        description: "Connect your own S3 bucket, use our cloud, or keep everything local. Unlike other tools, you're never locked into our infrastructure. Perfect for teams with compliance requirements or those who value data sovereignty.",
      },
      {
        title: "Privacy by default, sharing by choice",
        description: "Every recording starts private. Share when ready with password protection, expiring links, or domain restrictions. Your internal discussions, client work, and personal notes stay exactly that — personal.",
      },
      {
        title: "Async collaboration that actually works",
        description: "Comments, reactions, and transcripts keep conversations moving without another meeting. See who watched, get notified on feedback, and turn recordings into actionable next steps. Replace those \"quick sync\" calls for good.",
      },
      {
        title: "Works on your machine™ (and theirs)",
        description: "Native apps for macOS and Windows that feel at home on each platform. No janky Electron apps or browser extensions. Just fast, reliable recording that works with your existing tools and workflow.",
      },
      {
        title: "Quality that makes you look professional",
        description: "4K recording, 60fps capture, and intelligent compression that keeps file sizes reasonable. Auto-enhance removes background noise and balances audio. Your content looks and sounds like you hired a production team.",
      },
      {
        title: "Open source, not open season",
        description: "See exactly how Cap works, contribute features you need, or self-host for complete control. Join a community of builders who believe great tools should be transparent, extensible, and respect their users.",
      },
      {
        title: "AI that enhances, not replaces",
        description: "Smart titles, automatic chapters, and instant transcriptions powered by local AI. Remove filler words, generate summaries, or search across all your recordings. AI features that actually save time instead of creating more work.",
      },
    ],
  },
  testimonials: {
    title: "Loved by builders, trusted by teams",
    subtitle: "Join thousands who've made Cap their daily driver for visual communication.",
    cta: "Read more stories",
  },
  pricing: {
    title: "Pricing that scales with you",
    subtitle: "Start free, upgrade when you need more. Early adopter pricing locked in forever.",
    lovedBy: "Trusted by 10,000+ users",
    commercial: {
      title: "Desktop License",
      description: "For professionals who want unlimited local recording and editing.",
      features: [
        "Commercial use rights",
        "Unlimited local recordings",
        "Studio Mode with full editor",
        "Export to any format",
        "Community support",
      ],
      cta: "Get Desktop License",
      pricing: {
        yearly: 29,
        lifetime: 58,
      },
      labels: {
        licenses: "License type",
        yearly: "Annual",
        lifetime: "One-time",
      },
    },
    pro: {
      badge: "Best value",
      title: "Cap Pro",
      description: "Everything in Desktop plus cloud features for seamless sharing and collaboration.",
      features: [
        "Everything in Desktop License",
        "Unlimited cloud storage & bandwidth",
        "Custom domain (cap.yourdomain.com)",
        "Password protected shares",
        "Viewer analytics & engagement",
        "Team workspaces",
        "Custom S3 bucket support",
        "Priority support & early features",
      ],
      cta: "Start Free Trial",
      pricing: {
        annual: 6,
        monthly: 9,
      },
      labels: {
        users: "Per user",
        monthly: "Monthly",
        annually: "Annual (save 33%)",
      },
    },
  },
  faq: {
    title: "Questions? We've got answers.",
    items: [
      {
        question: "How is Cap different from Loom?",
        answer: "Cap gives you the best of both worlds: the simplicity of Loom with the power of professional tools. We're open source, support custom storage, offer better pricing, and our desktop app works offline. Plus, you actually own your content.",
      },
      {
        question: "What happens to my recordings if I cancel?",
        answer: "Your recordings are yours forever. If you cancel Pro, existing shares remain active and you can always export everything. Downgrade to our free plan to keep recording locally, or self-host to maintain all features.",
      },
      {
        question: "Do you offer team plans?",
        answer: "Yes! Cap Pro includes team workspaces where you can organize recordings, manage permissions, and collaborate. Volume discounts available for teams over 10 users. Contact us for custom enterprise features.",
      },
      {
        question: "Which platforms do you support?",
        answer: "Native desktop apps for macOS (Apple Silicon & Intel) and Windows. Web viewer works everywhere. Linux support is in beta. Mobile apps for iOS and Android coming soon.",
      },
      {
        question: "Can I use Cap for commercial purposes?",
        answer: "Absolutely! Any paid plan (Desktop License or Cap Pro) includes full commercial usage rights. Use Cap for client work, sell courses, or embed recordings anywhere. The free version is for personal use only.",
      },
      {
        question: "Is my data secure?",
        answer: "Security is core to Cap. End-to-end encryption for cloud storage, SOC 2 Type II compliance in progress, and option to use your own infrastructure. Regular security audits and bug bounty program keep your content safe.",
      },
      {
        question: "What about GDPR/HIPAA compliance?",
        answer: "Cap Pro supports custom S3 buckets in any region for GDPR compliance. For HIPAA and other regulations, our self-hosted option gives you complete control. We also offer signed BAAs for enterprise customers.",
      },
    ],
  },
  readyToGetStarted: {
    title: "Ready to upgrade how you communicate?",
    buttons: {
      primary: "Download Cap",
      secondary: "Start Free Trial",
    },
  },
}; 