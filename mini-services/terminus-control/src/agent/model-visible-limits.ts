/**
 * Largest UTF-8 artifact that may be loaded directly into one model-visible
 * episode. Larger payloads require a continuation/reference protocol.
 */
export const MAX_MODEL_VISIBLE_EPISODE_BYTES = 128 * 1_024;
