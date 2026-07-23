import { z } from "zod";

export const REPO_PARAM = z
  .string()
  .optional()
  .describe("owner/repo. Omit to auto-resolve from git/context.");

export const ISSUE_NUMBER_PARAM = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Defaults to active issue.");

export const BOARD_ID_PARAM = z.string().optional().describe("Board ID. Uses context if set.");

export function json(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function text(message: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: message }] };
}
