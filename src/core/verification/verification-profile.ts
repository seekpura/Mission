import { extname } from "node:path";
import type { Artifact, ArtifactType } from "../domain/artifact.ts";

export type VerificationProfileKind =
  | "generic"
  | "presentation"
  | "website"
  | "video"
  | "code"
  | "research";

export interface VerificationProfileCheck {
  id: string;
  objective: string;
  evidenceExpectation: string;
}

export interface VerificationProfile {
  id: string;
  kind: VerificationProfileKind;
  title: string;
  artifactTypes: ArtifactType[];
  mimeTypes?: string[];
  extensions?: string[];
  checks: VerificationProfileCheck[];
  evidenceRequirements: string[];
  instructions: string[];
  maxInlineBytes?: number;
}

export interface VerificationProfileSelection {
  profile: VerificationProfile;
  reason: "artifact-type" | "mime-type" | "extension" | "fallback";
}

const DEFAULT_PROFILES: VerificationProfile[] = [
  {
    id: "presentation-mission-review-v1",
    kind: "presentation",
    title: "Presentation mission review",
    artifactTypes: ["presentation"],
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.ms-powerpoint"
    ],
    extensions: [".pptx", ".ppt", ".odp"],
    maxInlineBytes: 128 * 1024,
    checks: [
      {
        id: "presentation-structure",
        objective: "Verify narrative/section order, required slides, hierarchy and coverage against the WorkItem acceptance criteria.",
        evidenceExpectation: "slide/page references, extracted slide text or render evidence"
      },
      {
        id: "presentation-visual-quality",
        objective: "Verify legibility, clipping/overflow, alignment, layout consistency, contrast and visual hierarchy.",
        evidenceExpectation: "rendered-slide inspection with slide identifiers"
      },
      {
        id: "presentation-content-integrity",
        objective: "Verify claims, numbers, labels and referenced facts are internally consistent and supported.",
        evidenceExpectation: "artifact content plus source/evidence references"
      },
      {
        id: "presentation-delivery-integrity",
        objective: "Verify the deliverable is usable in the requested presentation format and preserves required editability/structure when applicable.",
        evidenceExpectation: "file validation and, when available, native/render inspection"
      }
    ],
    evidenceRequirements: [
      "Use slide-specific or page-specific evidence for visual findings.",
      "Do not pass visual quality from source text alone when rendered-slide evidence is unavailable; mark the visual check inconclusive.",
      "Any final pass must account for all required slides/sections named by the WorkItem."
    ],
    instructions: [
      "Review the presentation as an authored communication artifact, not as a generic text document.",
      "Separate content correctness from visual/render quality so missing render evidence cannot be hidden by good prose."
    ]
  },
  {
    id: "website-mission-review-v1",
    kind: "website",
    title: "Website mission review",
    artifactTypes: ["website"],
    mimeTypes: ["text/html", "application/xhtml+xml"],
    extensions: [".html", ".htm"],
    maxInlineBytes: 256 * 1024,
    checks: [
      {
        id: "website-structure-content",
        objective: "Verify required pages/sections, information architecture and content coverage.",
        evidenceExpectation: "source/runtime page evidence and route/section references"
      },
      {
        id: "website-functional",
        objective: "Verify required navigation, interactions, links, forms and state transitions behave as intended.",
        evidenceExpectation: "runtime/browser/test evidence; source inspection alone is insufficient for behavioral claims"
      },
      {
        id: "website-responsive-accessible",
        objective: "Verify responsive behavior and material accessibility requirements such as semantic structure, keyboard reachability and readable contrast.",
        evidenceExpectation: "viewport/browser inspection or automated accessibility/runtime evidence"
      },
      {
        id: "website-runtime-quality",
        objective: "Verify there are no material runtime errors, broken assets or blocking console/network failures.",
        evidenceExpectation: "runtime/browser/test evidence"
      }
    ],
    evidenceRequirements: [
      "A functional pass requires runtime or test evidence for behavior; static source text is not enough.",
      "Responsive claims require evidence from relevant viewport states.",
      "If the available evidence does not exercise the requested behavior, return inconclusive for that check rather than guessing."
    ],
    instructions: [
      "Treat the website as an interactive system and distinguish source correctness from observed runtime behavior.",
      "Use requirement-scoped findings with route, selector, viewport or interaction context when available."
    ]
  },
  {
    id: "video-mission-review-v1",
    kind: "video",
    title: "Video mission review",
    artifactTypes: ["video"],
    mimeTypes: ["video/"],
    extensions: [".mp4", ".mov", ".webm", ".mkv"],
    maxInlineBytes: 32 * 1024,
    checks: [
      {
        id: "video-technical-integrity",
        objective: "Verify the media is playable and materially free of broken/corrupt output, missing tracks or invalid duration/encoding evidence.",
        evidenceExpectation: "media probe/runtime playback evidence"
      },
      {
        id: "video-temporal-content",
        objective: "Verify required scenes/messages, sequence, pacing and timing against the WorkItem criteria.",
        evidenceExpectation: "timecoded frame/transcript/playback evidence"
      },
      {
        id: "video-visual-audio-quality",
        objective: "Verify legibility, framing, continuity, audio intelligibility and material sync issues.",
        evidenceExpectation: "timecoded playback/frame/audio evidence"
      },
      {
        id: "video-claims-captions",
        objective: "Verify on-screen claims, captions/subtitles and spoken content are consistent with supplied evidence and requirements.",
        evidenceExpectation: "transcript/caption plus source/evidence references"
      }
    ],
    evidenceRequirements: [
      "Use timestamps for temporal findings whenever possible.",
      "Do not pass playback, sync or visual quality from filename/metadata alone.",
      "Missing media inspection evidence makes affected quality checks inconclusive."
    ],
    instructions: [
      "Review the video across time; do not collapse a temporal deliverable into a single static-content judgment.",
      "Keep technical playback integrity, visual/audio quality and claim correctness as separate checks."
    ]
  },
  {
    id: "code-mission-review-v1",
    kind: "code",
    title: "Code mission review",
    artifactTypes: ["code"],
    mimeTypes: ["text/x-", "application/javascript", "application/typescript", "application/json"],
    extensions: [
      ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".cs", ".cpp", ".c", ".h", ".sh"
    ],
    maxInlineBytes: 256 * 1024,
    checks: [
      {
        id: "code-requirement-correctness",
        objective: "Verify implemented behavior covers the WorkItem objective and acceptance criteria without unsupported completion claims.",
        evidenceExpectation: "source inspection plus requirement-scoped test/runtime evidence"
      },
      {
        id: "code-tests",
        objective: "Verify relevant automated tests or equivalent executable checks pass and cover material behavior and regressions.",
        evidenceExpectation: "test command/result evidence with failures or coverage gaps surfaced"
      },
      {
        id: "code-integration",
        objective: "Verify interfaces, schemas, dependencies and integration points remain compatible with the surrounding system.",
        evidenceExpectation: "build/type/schema/integration test evidence where applicable"
      },
      {
        id: "code-security-reliability",
        objective: "Verify material error handling, boundary validation, unsafe side effects and security-sensitive behavior appropriate to the change.",
        evidenceExpectation: "source plus targeted static/runtime/security evidence"
      }
    ],
    evidenceRequirements: [
      "A code pass requires executable evidence for behaviors that can be tested; source inspection alone is not sufficient when tests are feasible.",
      "Do not infer that a build/typecheck/test passed unless corresponding evidence is supplied.",
      "Surface untested or unverified integration assumptions as inconclusive or warning checks."
    ],
    instructions: [
      "Review code as part of a running system: correctness, tests, integration compatibility and failure behavior are distinct concerns.",
      "Prefer concrete failing examples and requirement-linked evidence over stylistic commentary."
    ]
  },
  {
    id: "research-mission-review-v1",
    kind: "research",
    title: "Research mission review",
    artifactTypes: ["research"],
    maxInlineBytes: 512 * 1024,
    checks: [
      {
        id: "research-question-coverage",
        objective: "Verify the research answers the requested questions and covers material dimensions without hiding unresolved uncertainty.",
        evidenceExpectation: "section/claim references mapped to the WorkItem objective and acceptance criteria"
      },
      {
        id: "research-source-quality",
        objective: "Verify material claims rely on appropriate, traceable and sufficiently authoritative sources for the claim type.",
        evidenceExpectation: "source references with provenance and publication/observation context when relevant"
      },
      {
        id: "research-claim-traceability",
        objective: "Verify important factual claims can be traced to supplied evidence and that inference is distinguished from source fact.",
        evidenceExpectation: "claim-to-source/evidence mapping"
      },
      {
        id: "research-recency-conflict",
        objective: "Verify time-sensitive claims use sufficiently current evidence and conflicting evidence is acknowledged/resolved rather than silently discarded.",
        evidenceExpectation: "dated sources/evidence and explicit treatment of disagreements"
      }
    ],
    evidenceRequirements: [
      "A research pass requires traceable evidence for material factual claims.",
      "For time-sensitive topics, missing recency metadata or stale evidence must be surfaced.",
      "When sources conflict, describe the conflict and the basis for any resolution; do not average incompatible claims."
    ],
    instructions: [
      "Review research for evidentiary integrity, not just writing quality.",
      "Separate source facts, synthesis and inference; uncertainty must remain visible when evidence does not settle a claim."
    ]
  },
  {
    id: "generic-mission-review-v1",
    kind: "generic",
    title: "Generic mission review",
    artifactTypes: ["file", "document", "image", "audio", "dataset", "other"],
    checks: [
      {
        id: "generic-requirement-coverage",
        objective: "Verify the artifact satisfies the WorkItem objective and local acceptance criteria.",
        evidenceExpectation: "artifact content and requirement-scoped evidence"
      },
      {
        id: "generic-content-quality",
        objective: "Verify internal consistency, material correctness and usability for the requested purpose.",
        evidenceExpectation: "artifact-specific evidence"
      }
    ],
    evidenceRequirements: [
      "Do not convert missing evidence into a pass.",
      "Use inconclusive when the artifact type requires inspection that is not represented by the supplied evidence."
    ],
    instructions: [
      "Adapt review detail to the artifact while preserving evidence-backed independent verification."
    ]
  }
];

export class VerificationProfileRegistry {
  private readonly profiles: VerificationProfile[];
  private readonly byId: Map<string, VerificationProfile>;

  constructor(profiles: VerificationProfile[] = DEFAULT_PROFILES) {
    if (profiles.length === 0) throw new Error("VerificationProfileRegistry requires at least one profile");
    this.profiles = profiles.map(profile => freezeProfile(profile));
    this.byId = new Map();
    for (const profile of this.profiles) {
      if (!profile.id.trim()) throw new Error("Verification profile id must be non-empty");
      if (this.byId.has(profile.id)) throw new Error(`Duplicate verification profile id: ${profile.id}`);
      this.byId.set(profile.id, profile);
    }
    if (!this.profiles.some(profile => profile.kind === "generic")) {
      throw new Error("VerificationProfileRegistry requires a generic fallback profile");
    }
  }

  get(id: string): VerificationProfile | undefined {
    return this.byId.get(id);
  }

  list(): VerificationProfile[] {
    return [...this.profiles];
  }

  select(artifact: Artifact): VerificationProfileSelection {
    const byType = this.profiles.find(profile => profile.kind !== "generic" && profile.artifactTypes.includes(artifact.type));
    if (byType) return { profile: byType, reason: "artifact-type" };

    const mimeType = artifact.mimeType?.trim().toLowerCase();
    if (mimeType) {
      const byMime = this.profiles.find(profile => profile.kind !== "generic" && profile.mimeTypes?.some(pattern => mimeMatches(mimeType, pattern)));
      if (byMime) return { profile: byMime, reason: "mime-type" };
    }

    const extension = extname(artifact.uri).toLowerCase();
    if (extension) {
      const byExtension = this.profiles.find(profile => profile.kind !== "generic" && profile.extensions?.includes(extension));
      if (byExtension) return { profile: byExtension, reason: "extension" };
    }

    const generic = this.profiles.find(profile => profile.kind === "generic");
    if (!generic) throw new Error("Generic verification profile missing");
    return { profile: generic, reason: "fallback" };
  }
}

export function createDefaultVerificationProfileRegistry(): VerificationProfileRegistry {
  return new VerificationProfileRegistry(DEFAULT_PROFILES);
}

function mimeMatches(value: string, pattern: string): boolean {
  const normalized = pattern.toLowerCase();
  return normalized.endsWith("/") ? value.startsWith(normalized) : value === normalized || value.startsWith(`${normalized};`);
}

function freezeProfile(profile: VerificationProfile): VerificationProfile {
  return {
    ...profile,
    artifactTypes: [...profile.artifactTypes],
    mimeTypes: profile.mimeTypes ? [...profile.mimeTypes] : undefined,
    extensions: profile.extensions?.map(value => value.toLowerCase()),
    checks: profile.checks.map(check => ({ ...check })),
    evidenceRequirements: [...profile.evidenceRequirements],
    instructions: [...profile.instructions]
  };
}
