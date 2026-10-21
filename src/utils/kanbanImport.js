/**
 * "Import from JSON" on the Kanban page: the boards a file or a paste
 * holds - an array of boards, the format of "Export All (JSON)" (which
 * writes the boards without their cards) - run through
 * src/utils/jsonImportMerge.js:
 *
 *   merge off  one createBoard() per item, as the page's file picker always
 *              did; the exported `id` is dropped so a board re-imported next
 *              to its original gets a new one (Dexie refused the duplicate
 *              key before);
 *   merge on   a board already here (same syncId, else the same title and
 *              category) is updated - title, category, columns - when the
 *              file's copy is newer (updatedAt), completed when the local
 *              one has blank fields, skipped when older or identical; the
 *              rest are added.
 *
 * Cards: a board item may carry a `cards` array (hand-made files; the
 * export does not write one). They are merged INSIDE the matched board by
 * their yjsId - the card identity that is unique across machines - newer
 * wins, unknown or id-less cards are added; cards already on the board
 * that the file does not mention are kept. The board is never replaced
 * whole: that would delete every card added here since the export, and a
 * card's identity is reliable enough to merge one by one (the same rule the
 * database import applies to kanbanCards). Cards are reported on their own
 * row of the summary.
 */
import { db } from '../db/database';
import { createBoard, createCard, generateCardYjsId } from './kanban';
import { keyPart, joinKey, importedIsNewer, missingFieldFills, withCreateDefaults } from './mergeCore';
import { runJsonImport } from './jsonImportMerge';

/** true, or the message the old picker raised. */
export function validateBoardsImport(data) {
  if (!Array.isArray(data)) return 'Invalid format: Expected an array of boards';
  if (data.length === 0) return 'Array is empty: No boards to import';
  const notObjects = data.map((b, i) => (b && typeof b === 'object' && !Array.isArray(b) ? null : i + 1)).filter(Boolean);
  if (notObjects.length) return `Invalid board structure: Items at positions ${notObjects.join(', ')} are not board objects`;
  return true;
}

const boardKey = (b) => joinKey(keyPart(b.title, 'Untitled Board'), keyPart(b.category, 'General'));
const boardLabel = (b) => `${keyPart(b.title, 'Untitled Board')} / ${keyPart(b.category, 'General')}`;
const updatedOrCreated = (row) => row?.updatedAt ?? row?.createdAt;

/**
 * Runs the import (or its dry run): { kind, mode: 'kanbanBoards', dryRun,
 * mergeMode, summary: { kanbanBoards, kanbanCards? }, totals }.
 */
export async function runBoardsImport(items, { dryRun = false, mergeMode = false } = {}) {
  const { createWriter, newSummary, tally, tallyInvalid, mergeTotals } = await import('./importDatabase');
  const writer = createWriter(dryRun);
  const cardsByBoard = new Map(); // local board id -> [cards from the file]
  const result = await runJsonImport(items, {
    dryRun, mergeMode, type: 'kanbanBoards', table: db.kanbanBoards, keyOf: boardKey, labelOf: boardLabel,
    // the cards travel separately; the board row never stores them
    prepare: (rest) => {
      const { cards: _cards, ...board } = rest;
      return board;
    },
    createDefaults: { category: 'General', createdAt: () => new Date(), updatedAt: () => new Date() },
    createOne: async (record) => (await createBoard(record)).id,
    track: (imported, localId) => {
      if (Array.isArray(imported.cards) && imported.cards.length && localId != null) cardsByBoard.set(localId, imported.cards);
    },
  });

  if (cardsByBoard.size > 0) {
    const cards = newSummary();
    const localByYjsId = new Map();
    if (mergeMode) {
      await db.kanbanCards.each((card) => {
        if (card.yjsId != null && card.yjsId !== '') localByYjsId.set(String(card.yjsId), card);
      });
    }
    for (const [boardId, list] of cardsByBoard) {
      for (const imported of list) {
        if (imported === null || typeof imported !== 'object' || Array.isArray(imported)) {
          tallyInvalid(cards, '', 'not a card object');
          continue;
        }
        const label = keyPart(imported.title) || (imported.yjsId != null ? `card ${imported.yjsId}` : 'card');
        try {
          const { id: _id, ...rest } = imported;
          const local = mergeMode && imported.yjsId != null && imported.yjsId !== '' ? localByYjsId.get(String(imported.yjsId)) : undefined;
          if (!local) {
            if (dryRun) {
              tally(cards, 'created', label);
            } else if (mergeMode) {
              await writer.add(db.kanbanCards, withCreateDefaults({ ...rest, boardId, yjsId: imported.yjsId || generateCardYjsId() }, { createdAt: () => new Date(), updatedAt: () => new Date() }));
              tally(cards, 'created', label);
            } else {
              await createCard({ ...rest, boardId });
              tally(cards, 'created', label);
            }
          } else if (importedIsNewer(updatedOrCreated(imported), updatedOrCreated(local))) {
            await writer.put(db.kanbanCards, { ...rest, boardId: local.boardId, id: local.id });
            tally(cards, 'updated', label);
          } else {
            const fills = missingFieldFills(local, { ...rest, boardId: local.boardId });
            if (Object.keys(fills).length) {
              await writer.update(db.kanbanCards, local.id, fills);
              tally(cards, 'filled', label);
            } else {
              tally(cards, 'skipped', label);
            }
          }
        } catch (error) {
          tallyInvalid(cards, label, error?.message || String(error));
        }
      }
    }
    result.summary.kanbanCards = cards;
    result.totals = mergeTotals(result.summary);
  }
  return result;
}
