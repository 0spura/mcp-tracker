import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ContextStore } from '../../context/store.js';
import type { BoardProvider } from './capabilities.js';
import {
  json,
  text,
  BOARD_ID_PARAM,
  ISSUE_NUMBER_PARAM,
  resolveIssueId,
  resolveScope,
} from '../../tools/helpers.js';

export function registerBoardTools(
  server: McpServer,
  board: BoardProvider,
  ctx: ContextStore,
  requires: Array<'repo' | 'board'>
): void {
  const scopeOf = (boardId?: string) => resolveScope(ctx, [...requires, 'board'], undefined, boardId);

  server.tool(
    'list_board_items',
    'List all items on the board, paginating through every page.',
    { board_id: BOARD_ID_PARAM },
    async (args) => json(await board.listBoardItems(await scopeOf(args.board_id)))
  );

  server.tool(
    'list_board_fields',
    'List the board\u2019s custom fields and their options (Size, Priority, Sprint, Status, etc.).',
    { board_id: BOARD_ID_PARAM },
    async (args) => json(await board.listBoardFields(await scopeOf(args.board_id)))
  );

  server.tool(
    'add_issue_to_board',
    'Add an issue to the board; returns the board item ID. Defaults to the active issue.',
    { number: ISSUE_NUMBER_PARAM, board_id: BOARD_ID_PARAM },
    async (args) => {
      const scope = await scopeOf(args.board_id);
      const itemId = await board.addIssueToBoard(scope, await resolveIssueId(ctx, args.number));
      return json({ item_id: itemId });
    }
  );

  server.tool(
    'set_item_fields',
    'Set board field values on an item (Size, Priority, Sprint, etc.). Unknown fields or options error with the valid values listed.',
    {
      item_id: z.string().describe('Board item ID from add_issue_to_board or list_board_items.'),
      fields: z.record(z.string()).describe('Field name to value, e.g. {"Size": "M"}.'),
      board_id: BOARD_ID_PARAM,
    },
    async (args) => {
      await board.setItemFields(await scopeOf(args.board_id), args.item_id, args.fields);
      return text('fields updated');
    }
  );
}
