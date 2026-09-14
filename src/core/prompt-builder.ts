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
 * A relation triplet supplied by a graph/memory backend, e.g.
 * `[RELATION](Dana)-[SUPERSEDES]->(Dana, on-call for billing)`.
 */
const RELATION_TRIPLET_RE =
  /\[(?:GRAPH )?RELATION\]\s*\((.+?)\)\s*-\[?:?([A-Z_]+)[^\]]*\]?->\s*\((.+?)\)$/i;

/**
 * An explicit per-item supersession declaration. An item whose text begins
 * with `[SUPERSEDES: <memoryId>]` states that the situational item carrying
 * that memoryId has been superseded by this item. The marker is machine
 * metadata: it is stripped from the rendered text and the target is pruned.
 */
const SUPERSEDES_MARKER_RE = /^\[SUPERSEDES:\s*([^\]]+?)\s*\]\s*/;

/**
 * Resolves declared supersession/restriction signals in situational context.
 *
 * Only explicit signals are acted on — never free-text inference:
 *
 * - Relation triplets (`[RELATION](source)-[PREDICATE]->(target)`) are
 *   formatted for presentation: SUPERSEDES/REPLACES render the source as the
 *   active state, FORBIDDEN_DUE_TO as a restriction, CONFIDENTIAL_INVARIANT
 *   as a withheld-details notice naming the target. An item whose text is an
 *   exact (case-insensitive) match of a SUPERSEDES/REPLACES target is pruned.
 * - `[SUPERSEDES: <memoryId>]` markers prune the targeted item by id; the
 *   declaring item renders with the marker stripped.
 *
 * Everything else passes through verbatim. Partial mentions of a superseded
 * entity are deliberately retained — false negatives are preferable to
 * silently dropping content the caller never marked superseded.
 */
export function resolveSupersededContext(situationalItems: SituationalContextItem[]): SituationalContextItem[] {
  const supersededIds = new Set<string>();
  const tripletTargets = new Set<string>();

  for (const item of situationalItems) {
    const marker = item.text.match(SUPERSEDES_MARKER_RE);
    if (marker) supersededIds.add(marker[1]!);
    const triplet = item.text.match(RELATION_TRIPLET_RE);
    if (triplet && /^(SUPERSEDES|REPLACES)$/i.test(triplet[2]!)) {
      tripletTargets.add(triplet[3]!.trim().toLowerCase());
    }
  }

  const resolved: SituationalContextItem[] = [];
  for (const item of situationalItems) {
    if (supersededIds.has(item.memoryId)) continue;

    const marker = item.text.match(SUPERSEDES_MARKER_RE);
    if (marker) {
      resolved.push({ ...item, text: item.text.slice(marker[0].length) });
      continue;
    }

    const triplet = item.text.match(RELATION_TRIPLET_RE);
    if (triplet) {
      const source = triplet[1]!.trim();
      const predicate = triplet[2]!.toUpperCase();
      const target = triplet[3]!.trim();
      if (predicate === "SUPERSEDES" || predicate === "REPLACES") {
        resolved.push({ ...item, text: `[ACTIVE STATE] ${source}` });
      } else if (predicate === "FORBIDDEN_DUE_TO") {
        resolved.push({ ...item, text: `[RESTRICTION] ${source} (FORBIDDEN DUE TO: ${target})` });
      } else if (predicate === "CONFIDENTIAL_INVARIANT") {
        resolved.push({ ...item, text: `[CONFIDENTIAL INVARIANT] (${target} — details withheld)` });
      } else {
        resolved.push(item);
      }
      continue;
    }

    if (tripletTargets.has(item.text.trim().toLowerCase())) continue;

    resolved.push(item);
  }

  return resolved;
}

export function formatSlotsToMarkdown(slots: PAESlots): string {
  const parts: string[] = [];

  if (slots.asker_context && slots.asker_context.length > 0) {
    parts.push("### [ASKER CONTEXT: Pinned Rules & Preferences]");
    for (const item of slots.asker_context) {
      parts.push(`- ${item.text}`);
    }
  }

  const situational = resolveSupersededContext(slots.situational_context ?? []);

  if (situational.length > 0) {
    parts.push("### [SITUATIONAL CONTEXT: Recent Decisions & Context]");
    for (const item of situational) {
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
