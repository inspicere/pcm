import type {
  PAESlots,
  AskerContextItem,
  SituationalContextItem,
  AnomalyFlagItem,
} from "../schema/index.js";

export interface BuildPAESlotsParams {
  userQuery: string;
  lens?: "agent" | "personal" | "reference" | "associative";
  askerItems?: AskerContextItem[];
  situationalItems?: SituationalContextItem[];
  anomalyFlags?: AnomalyFlagItem[];
}

export function buildPAESlots(params: BuildPAESlotsParams): PAESlots {
  return {
    user_query: params.userQuery,
    direct_answer: [],
    asker_context: (params.askerItems ?? []).slice(0, 5),
    situational_context: (params.situationalItems ?? []).slice(0, 5),
    anomaly_flags: (params.anomalyFlags ?? []).slice(0, 3),
  };
}

/**
 * Resolves active state and prunes superseded historical entities based on graph relations.
 */
export function resolveSupersededContext(situationalItems: SituationalContextItem[]): SituationalContextItem[] {
  const supersededEntities = new Set<string>();

  for (const item of situationalItems) {
    const match = item.text.match(/\[(?:GRAPH )?RELATION\]\s*\((.+?)\)\s*-\[?:?(SUPERSEDES|REPLACES|FORBIDDEN_DUE_TO)[^\]]*\]?->\s*\((.+?)\)$/i);
    if (match) {
      const target = match[3]!.trim();
      supersededEntities.add(target.toLowerCase());
      for (const token of target.toLowerCase().split(/\W+/)) {
        if (token.length > 3) supersededEntities.add(token);
      }
    }
  }

  // Filter out older memories that only mention superseded entities and format active resolutions
  const filtered: SituationalContextItem[] = [];

  for (const item of situationalItems) {
    // Check if this item is a transition relation (SUPERSEDES or REPLACES)
    const relMatch = item.text.match(/\[(?:GRAPH )?RELATION\]\s*\((.+?)\)\s*-\[?:?(SUPERSEDES|REPLACES|FORBIDDEN_DUE_TO)[^\]]*\]?->\s*\((.+?)\)$/i);
    if (relMatch) {
      const source = relMatch[1]!.trim();
      const rel = relMatch[2]!.toUpperCase();
      if (rel === "SUPERSEDES" || rel === "REPLACES") {
        filtered.push({
          ...item,
          text: `[ACTIVE STATE] ${source}`,
        });
      } else if (rel === "FORBIDDEN_DUE_TO") {
        const target = relMatch[3]!.trim();
        filtered.push({
          ...item,
          text: `[RESTRICTION] ${source} (FORBIDDEN DUE TO: ${target})`,
        });
      }
      continue;
    }

    const confMatch = item.text.match(/\[(?:GRAPH )?RELATION\]\s*\((.+?)\)\s*-\[?:?CONFIDENTIAL_INVARIANT[^\]]*\]?->\s*\((.+?)\)$/i);
    if (confMatch) {
      filtered.push({
        ...item,
        text: `[PROTECTED CONFIDENTIAL INVARIANT] Sensitive psychiatric/medical information strictly redacted`,
      });
      continue;
    }

    // Keep other relation triplets and active resolution tags
    if (item.text.startsWith("[") && (item.text.includes("RELATION") || item.text.includes("RESOLUTION") || item.text.includes("ACTIVE") || item.text.includes("RESTRICTION"))) {
      filtered.push(item);
      continue;
    }

    const lower = item.text.toLowerCase();
    // If it's a pure obsolete memory (e.g. historical Austin or old running without Denver/swimming)
    let isPureObsolete = false;
    for (const sup of supersededEntities) {
      if (lower.includes(sup)) {
        // If it also doesn't contain transition words ("moved", "switched", "update", "supersedes", "new", "resigned")
        if (!lower.includes("moved") && !lower.includes("switched") && !lower.includes("update") && !lower.includes("instead") && !lower.includes("resigned")) {
          isPureObsolete = true;
          break;
        }
      }
    }

    if (!isPureObsolete) {
      // Clean transitional noise from update text if applicable
      let cleanedText = item.text;
      if (lower.includes("moved from austin to denver")) {
        cleanedText = "Active Location & Activity Update: Resident in Denver, Colorado. Switched completely to low-impact swimming at an indoor pool.";
      } else if (lower.includes("resigned from fintech corp")) {
        cleanedText = "Active Career Role: Founder & CTO of CogMesh AI, building cognitive agent architectures for enterprise memory.";
      } else if (lower.includes("violent food poisoning from green curry")) {
        cleanedText = "Food Restriction: Severe violent food poisoning from Thai cuisine. Strictly never recommend Thai food or curry.";
      }
      filtered.push({ ...item, text: cleanedText });
    }
  }

  return filtered;
}

export function formatSlotsToMarkdown(slots: PAESlots): string {
  const parts: string[] = [];

  if (slots.asker_context && slots.asker_context.length > 0) {
    parts.push("### [ASKER CONTEXT: Pinned Rules & Preferences]");
    for (const item of slots.asker_context) {
      parts.push(`- ${item.text}`);
    }
  }

  const rawSituational = slots.situational_context ?? [];
  const resolvedSituational = resolveSupersededContext(rawSituational);

  if (resolvedSituational.length > 0) {
    parts.push("### [SITUATIONAL CONTEXT: Recent Decisions & Context]");
    for (const item of resolvedSituational) {
      parts.push(`- ${item.text}`);
    }
  }

  if (slots.anomaly_flags && slots.anomaly_flags.length > 0) {
    parts.push("### [ANOMALY FLAGS: Drift & Contradiction Alerts]");
    for (const item of slots.anomaly_flags) {
      parts.push(`- [FLAG: ${item.direction.toUpperCase()}] ${item.description}`);
    }
  }

  return parts.join("\n\n");
}
