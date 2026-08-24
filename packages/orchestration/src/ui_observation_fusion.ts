/**
 * Pure coordinator for fusing structural browser or desktop observations.
 * It does not capture a screen, inspect pixels, or authorize an effect.
 */
import { computeContentHash } from "@terminus/context-ir";
import {
  uiObservationInputSchema,
  uiObservationSchema,
  type UiAccessibilityNode,
  type UiBoundingBox,
  type UiDomNode,
  type UiElementTarget,
  type UiObservation,
  type UiObservationInput,
  type UiViewport,
} from "@terminus/domain";

export type FuseObservationParams = UiObservationInput;

const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "menuitem",
  "tab",
  "switch",
]);

const INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  "button",
  "a",
  "input",
  "select",
  "textarea",
]);

export class ObservationFusionEngine {
  /** Validate adapter input, fuse structural targets, and return a canonical observation. */
  public fuseObservation(raw: FuseObservationParams): UiObservation {
    uiObservationInputSchema.parse(raw);
    const input = raw;
    const targetElements = this.extractTargetElements(
      input.viewport,
      input.domNodes,
      input.accessibilityNodes,
    );

    const observation: UiObservation = {
      id: input.id,
      sessionId: input.sessionId,
      taskId: input.taskId,
      timestamp: input.timestamp,
      viewport: input.viewport,
      screenshotArtifactId: input.screenshotArtifactId,
      domTreeArtifactId: input.domTreeArtifactId,
      documentUri: input.documentUri,
      accessibilityTree: input.accessibilityNodes,
      focusedElementId: input.focusedElementId,
      targetElements,
      taintLabel: input.taintLabel,
      version: input.version,
    };
    uiObservationSchema.parse(observation);
    return observation;
  }

  /**
   * Fuse DOM and accessibility nodes by node identity. Missing geometry is not
   * invented because fabricated coordinates could turn stale text into a click.
   */
  public extractTargetElements(
    viewport: UiViewport,
    domNodes: readonly UiDomNode[],
    accessibilityNodes: readonly UiAccessibilityNode[],
  ): readonly UiElementTarget[] {
    const domById = new Map(domNodes.map((node) => [node.nodeId, node] as const));
    const targets = new Map<string, UiElementTarget>();

    for (const a11y of accessibilityNodes) {
      const role = a11y.role.toLowerCase();
      if (a11y.disabled || (!INTERACTIVE_ROLES.has(role) && !a11y.focused)) continue;
      const dom = domById.get(a11y.nodeId);
      const box = this.usableBox(a11y.boundingBox ?? dom?.boundingBox ?? null, viewport);
      if (box === null) continue;
      const name = a11y.name || dom?.text || dom?.attributes.name || role;
      const selector = this.selectorFor(a11y.nodeId, dom, role);
      const evidenceSources = dom === undefined
        ? ["accessibility"] as const
        : ["accessibility", "dom"] as const;
      targets.set(a11y.nodeId, {
        elementId: a11y.nodeId,
        role,
        name,
        selector,
        boundingBox: box,
        textSnippet: a11y.name || a11y.description || a11y.value || dom?.text || null,
        confidence: dom === undefined ? 0.85 : 0.95,
        semanticHash: this.computeSemanticHash(a11y.nodeId, role, name, selector),
        evidenceSources,
      });
    }

    for (const dom of domNodes) {
      if (targets.has(dom.nodeId)) continue;
      const tag = dom.tag.toLowerCase();
      if (!dom.isInteractive && !INTERACTIVE_TAGS.has(tag)) continue;
      const box = this.usableBox(dom.boundingBox, viewport);
      if (box === null) continue;
      const role = dom.attributes.role?.toLowerCase() ?? tag;
      const name = dom.text ?? dom.attributes.name ?? dom.attributes.id ?? tag;
      const selector = this.selectorFor(dom.nodeId, dom, role);
      targets.set(dom.nodeId, {
        elementId: dom.nodeId,
        role,
        name,
        selector,
        boundingBox: box,
        textSnippet: dom.text,
        confidence: 0.8,
        semanticHash: this.computeSemanticHash(dom.nodeId, role, name, selector),
        evidenceSources: ["dom"],
      });
    }

    return [...targets.values()].sort((left, right) =>
      left.elementId.localeCompare(right.elementId),
    );
  }

  public findTargetBySelector(observation: UiObservation, selector: string): UiElementTarget | null {
    const normalized = selector.trim().toLowerCase();
    return observation.targetElements.find((target) =>
      target.selector.toLowerCase() === normalized
      || target.elementId.toLowerCase() === normalized
      || `#${target.elementId.toLowerCase()}` === normalized,
    ) ?? null;
  }

  public findTargetByPoint(observation: UiObservation, x: number, y: number): UiElementTarget | null {
    const hits = observation.targetElements.filter((target) => {
      const box = target.boundingBox;
      return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
    });
    hits.sort((left, right) =>
      left.boundingBox.width * left.boundingBox.height
      - right.boundingBox.width * right.boundingBox.height,
    );
    return hits[0] ?? null;
  }

  public findTargetBySemanticMatch(observation: UiObservation, query: string): UiElementTarget | null {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) return null;
    const exact = observation.targetElements.find((target) =>
      target.name.toLowerCase() === normalized
      || target.textSnippet?.toLowerCase() === normalized,
    );
    if (exact !== undefined) return exact;
    return observation.targetElements.find((target) =>
      target.name.toLowerCase().includes(normalized)
      || target.textSnippet?.toLowerCase().includes(normalized),
    ) ?? null;
  }

  private selectorFor(nodeId: string, dom: UiDomNode | undefined, role: string): string {
    if (dom?.attributes.id) return `#${dom.attributes.id}`;
    return dom === undefined ? `a11y:${role}:${nodeId}` : `dom:${dom.tag}:${nodeId}`;
  }

  private computeSemanticHash(elementId: string, role: string, name: string, selector: string): string {
    const canonical = JSON.stringify({ elementId, role, name, selector });
    return computeContentHash(canonical);
  }

  private usableBox(box: UiBoundingBox | null, viewport: UiViewport): UiBoundingBox | null {
    if (box === null) return null;
    const x = Math.max(0, Math.min(box.x, viewport.width));
    const y = Math.max(0, Math.min(box.y, viewport.height));
    const width = Math.max(0, Math.min(box.width, viewport.width - x));
    const height = Math.max(0, Math.min(box.height, viewport.height - y));
    return width === 0 || height === 0 ? null : { x, y, width, height };
  }
}
