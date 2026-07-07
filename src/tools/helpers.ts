import { z } from "zod";

export const REPO_PARAM = z
  .string()
  .optional()
  .describe("Repository as owner/repo. Omit to resolve automatically from the git remote, .mcp-tracker.json, or a tracker_set_context override.");

export function json(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function text(message: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: message }] };
}
