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

export function formatSlotsToMarkdown(slots: PAESlots): string {
  const parts: string[] = [];

  if (slots.asker_context && slots.asker_context.length > 0) {
    parts.push("### [ASKER CONTEXT: Pinned Rules & Preferences]");
    for (const item of slots.asker_context) {
      parts.push(`- ${item.text}`);
    }
  }

  if (slots.situational_context && slots.situational_context.length > 0) {
    parts.push("### [SITUATIONAL CONTEXT: Recent Decisions & Context]");
    for (const item of slots.situational_context) {
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
