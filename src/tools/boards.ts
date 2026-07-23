import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextStore } from "../context.js";
import type { BoardProvider } from "../interfaces/board.js";
import { REPO_PARAM, BOARD_ID_PARAM, json, text } from "./helpers.js";

function resolveBoardId(ctx: ContextStore, boardId?: string): string {
  const id = boardId ?? ctx.boardId;
  if (!id) throw new Error("board_id is required. Set it via tracker_set_context or pass it explicitly.");
  return id;
}

export function registerBoardTools(server: McpServer, board: BoardProvider, ctx: ContextStore): void {
  server.tool(
    "list_board_items",
    "List all items on the board/project",
    { repo: REPO_PARAM, board_id: BOARD_ID_PARAM },
    async ({ repo, board_id }) =>
      json(await board.listBoardItems(ctx.resolveRepo(repo), resolveBoardId(ctx, board_id)))
  );

  server.tool(
    "list_board_fields",
    "List custom fields and options for the board. Call before creating issues to know which fields (Size, Priority, etc.) are available.",
    { repo: REPO_PARAM, board_id: BOARD_ID_PARAM },
    async ({ repo, board_id }) =>
      json(await board.listBoardFields(ctx.resolveRepo(repo), resolveBoardId(ctx, board_id)))
  );

  server.tool(
    "add_issue_to_board",
    "Add an existing issue to the board. Returns the item ID needed for set_item_fields.",
    {
      repo: REPO_PARAM,
      issue_number: z.number().int().positive(),
      board_id: BOARD_ID_PARAM,
    },
    async ({ repo, issue_number, board_id }) => {
      const itemId = await board.addIssueToBoard(ctx.resolveRepo(repo), issue_number, resolveBoardId(ctx, board_id));
      return json({ item_id: itemId });
    }
  );

  server.tool(
    "set_item_fields",
    "Set field values (Size, Priority, Sprint, etc.) on a board item. Use list_board_fields first to see available fields and options.",
    {
      repo: REPO_PARAM,
      board_id: BOARD_ID_PARAM,
      item_id: z.string().describe("Item ID returned by add_issue_to_board or list_board_items"),
      fields: z.record(z.string()).describe("Field name → value pairs, e.g. { \"Size\": \"M\", \"Priority\": \"High\" }"),
    },
    async ({ repo, board_id, item_id, fields }) => {
      await board.setItemFields(ctx.resolveRepo(repo), resolveBoardId(ctx, board_id), item_id, fields);
      return text(`Fields updated: ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
  );
}
