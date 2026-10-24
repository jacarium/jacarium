import { useCallback, useEffect, useRef, useState } from 'react';
import { Group, Puzzle, Ungroup, X } from 'lucide-react';
import { useLocalStorage } from '../../../hooks/useLocalStorage';

// Word-type sets used by classifyWord. These are deliberately small, closed
// classes - the words a human would recognize instantly as "structural glue"
// when sorting a scrambled word bag by type. Everything not in one of these
// sets falls through to "content", because distinguishing noun/verb/adjective
// needs real NLP, which this tool intentionally does not have.
const NUMBER_WORDS = new Set([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty',
  'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand',
  'million', 'billion', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth',
  'seventh', 'eighth', 'ninth', 'tenth'
]);

const ARTICLES = new Set(['a', 'an', 'the']);

const PREPOSITIONS = new Set([
  'of', 'in', 'to', 'for', 'with', 'on', 'at', 'by', 'from', 'into', 'onto',
  'upon', 'over', 'under', 'between', 'among', 'through', 'during', 'before',
  'after', 'about', 'against', 'without', 'within', 'along', 'across',
  'behind', 'beyond', 'above', 'below', 'near', 'off', 'out', 'since', 'than',
  'till', 'until', 'up', 'down', 'around', 'toward', 'towards'
]);

const CONJUNCTIONS = new Set([
  'and', 'but', 'or', 'nor', 'so', 'yet', 'because', 'although', 'though',
  'while', 'if', 'unless', 'since', 'as', 'whether'
]);

// Quantifier-pronouns (one, all, some, any, each) are deliberately excluded:
// "one" must classify as a number word in a puzzle bag, and the others carry
// no more structural signal than a content word does.
const PRONOUNS = new Set([
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us',
  'them', 'this', 'that', 'these', 'those', 'who', 'whom', 'whose', 'which',
  'what', 'myself', 'yourself', 'himself', 'herself', 'itself', 'ourselves',
  'yourselves', 'themselves'
]);

// Rendering order of the word bank, plus per-category accent colors. The
// accents are Tailwind utility colors with explicit dark: variants so chips
// stay readable in both themes; the chip base stays on bg-os-card like every
// other small control in this directory.
const CATEGORIES = [
  {
    id: 'number',
    label: 'Number words',
    chip: 'border-amber-400 dark:border-amber-600 text-amber-700 dark:text-amber-300'
  },
  {
    id: 'article',
    label: 'Articles',
    chip: 'border-blue-400 dark:border-blue-600 text-blue-700 dark:text-blue-300'
  },
  {
    id: 'preposition',
    label: 'Prepositions',
    chip: 'border-purple-400 dark:border-purple-600 text-purple-700 dark:text-purple-300'
  },
  {
    id: 'conjunction',
    label: 'Conjunctions',
    chip: 'border-emerald-400 dark:border-emerald-600 text-emerald-700 dark:text-emerald-300'
  },
  {
    id: 'pronoun',
    label: 'Pronouns',
    chip: 'border-rose-400 dark:border-rose-600 text-rose-700 dark:text-rose-300'
  },
  {
    id: 'content',
    label: 'Content words',
    chip: 'border-os-border text-os-text-primary'
  }
];

const CHIP_CLASS_BY_CATEGORY = Object.fromEntries(
  CATEGORIES.map((category) => [category.id, category.chip])
);

const TRAILING_PUNCTUATION = /[,.?!;:]+$/;

/**
 * Lowercase a token and strip leading/trailing punctuation, so "The," and
 * "the" compare equal. Internal characters (apostrophes in "don't") survive.
 */
function normalizeWord(token) {
  return token
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '');
}

/**
 * Assign a token to exactly one word-type bucket. Checked in a fixed priority
 * order - first match wins - so overlapping members resolve predictably:
 * "one" is a number word (not a pronoun), "since" is a preposition (not a
 * conjunction).
 */
function classifyWord(token) {
  const word = normalizeWord(token);
  if (NUMBER_WORDS.has(word)) return 'number';
  if (ARTICLES.has(word)) return 'article';
  if (PREPOSITIONS.has(word)) return 'preposition';
  if (CONJUNCTIONS.has(word)) return 'conjunction';
  if (PRONOUNS.has(word)) return 'pronoun';
  return 'content';
}

/**
 * Split raw input on whitespace into stable token objects. Each token keeps
 * its text exactly as typed (capitalization and attached punctuation are
 * solving clues, not noise) and gets a fresh index-based id, so repeated words
 * like three separate "the"s stay independently trackable through the bank
 * and the board.
 */
function tokenize(text) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) => ({
      id: index,
      text: word,
      category: classifyWord(word),
      capitalized: /^[^\p{L}]*\p{Lu}/u.test(word),
      punctuation: (word.match(TRAILING_PUNCTUATION) || [''])[0]
    }));
}

/** Words appearing more than once (case/punctuation insensitive), most first. */
function repeatedWords(text) {
  const counts = new Map();
  text
    .split(/\s+/)
    .filter(Boolean)
    .forEach((token) => {
      const word = normalizeWord(token);
      if (!word) return;
      counts.set(word, (counts.get(word) || 0) + 1);
    });
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

// Per-group boundary palette, assigned by groupId modulo. Deliberately a
// different visual language from both the category chips (solid 1px borders
// in amber/blue/purple/emerald/rose) and the marquee (solid os-blue): group
// boundaries are dashed 2px with a faint matching fill, in hues the
// categories don't use. Modulo assignment keeps a color stable for a group's
// lifetime and avoids reuse while five or fewer groups coexist.
const GROUP_STYLES = [
  {
    box: 'border-indigo-500/70 bg-indigo-500/10',
    button: 'border-indigo-500/70 text-indigo-600 dark:text-indigo-300'
  },
  {
    box: 'border-teal-500/70 bg-teal-500/10',
    button: 'border-teal-500/70 text-teal-600 dark:text-teal-300'
  },
  {
    box: 'border-fuchsia-500/70 bg-fuchsia-500/10',
    button: 'border-fuchsia-500/70 text-fuchsia-600 dark:text-fuchsia-300'
  },
  {
    box: 'border-orange-500/70 bg-orange-500/10',
    button: 'border-orange-500/70 text-orange-600 dark:text-orange-300'
  },
  {
    box: 'border-cyan-500/70 bg-cyan-500/10',
    button: 'border-cyan-500/70 text-cyan-600 dark:text-cyan-300'
  }
];

// Padding between a group's outermost member edges and its drawn boundary.
const GROUP_PADDING = 10;

/**
 * Clear groupId on every node whose group has fewer than 2 members - a
 * 1-member "group" is meaningless and should not draw a boundary around a
 * single pin. Pure helper shared by removal and group-reassignment paths.
 */
function dissolveUndersizedGroups(list) {
  const counts = new Map();
  list.forEach((node) => {
    if (node.groupId == null) return;
    counts.set(node.groupId, (counts.get(node.groupId) || 0) + 1);
  });
  if (![...counts.values()].some((count) => count < 2)) return list;
  return list.map((node) =>
    node.groupId != null && counts.get(node.groupId) < 2
      ? { ...node, groupId: null }
      : node
  );
}

// Fallback chip dimensions used only for the single frame before a freshly
// mounted node has been measured; the measure effect below re-renders with
// real sizes immediately after commit.
const APPROX_NODE_WIDTH = 80;
const APPROX_NODE_HEIGHT = 30;

/**
 * SentenceBuilderTool - a manual scaffolding aid for word-scramble puzzles.
 *
 * Not a solver: there is no NLP here. It mechanizes the "war room corkboard"
 * technique - sort the bag by word type, spot repeated words as structural
 * clues, read capitalization and punctuation as anchors, then pin words to a
 * freeform board (the same word as many times as you like - the bank is a
 * permanent source, not a depleting pool), drag them into visual groups to
 * try candidate arrangements side by side, rubber-band select a cluster to
 * move it as one, and click individual words to toggle them in or out of
 * that selection. A 2+ selection can be promoted to a persistent group: it
 * keeps a dashed color-coded boundary even when deselected, drags as one
 * unit, and dissolves via its ungroup button. Backspace/Delete removes the
 * selected pins. The board itself is the visualization - there is no
 * separate text-assembly area.
 *
 * Board state ({ input, nodes, nextNodeId, nextGroupId } - everything else
 * is derived or transient) is continuously auto-saved to localStorage as it
 * changes and silently restored on the next mount, so reopening the tool
 * always resumes exactly where the user left off - no explicit save action.
 * "Saved" and "current" are the same thing, so Reset All's fresh state is
 * itself persisted and becomes what the next open resumes.
 */
export default function SentenceBuilderTool() {
  // Auto-saved board snapshot, or null before the board is first used.
  // Read once at mount to restore; continuously rewritten by the auto-save
  // effect below. Writes are debounced (500ms) because nodes updates on
  // every mousemove pixel during a drag - the debounce coalesces those into
  // infrequent localStorage writes, and the hook flushes any pending write
  // on unmount/beforeunload so the latest state is never lost.
  const [savedBoard, setSavedBoard] = useLocalStorage('sentenceBuilderBoard', null, 500);
  // Shape-check the snapshot before trusting it, so a missing or malformed
  // save degrades to the normal empty first-run state instead of crashing.
  const restored =
    savedBoard &&
    typeof savedBoard.input === 'string' &&
    Array.isArray(savedBoard.nodes) &&
    Number.isInteger(savedBoard.nextNodeId) &&
    Number.isInteger(savedBoard.nextGroupId)
      ? savedBoard
      : null;
  const [input, setInput] = useState(restored ? restored.input : '');
  const [loaded, setLoaded] = useState(restored != null);
  // Permanent word bank: set once per Load Words from tokenize(input) and
  // never mutated as words get placed. Every original word stays available
  // here no matter how many copies of it are already pinned to the board.
  // bankTokens is deterministically derived from input, so the saved
  // snapshot doesn't store it - restoring re-tokenizes the saved input.
  const [bankTokens, setBankTokens] = useState(() =>
    restored ? tokenize(restored.input) : []
  );
  // Freely-positioned board pins. Each entry is { id, token, x, y, groupId }
  // where id is a fresh per-instance node id (NOT token.id - the same token
  // can be placed multiple times simultaneously, so each copy needs its own
  // identity for keys, dragging, selection, and removal), x/y is the node's
  // top-left offset within the board, and groupId is the persistent group it
  // belongs to (null when ungrouped).
  const [nodes, setNodes] = useState(restored ? restored.nodes : []);
  // Monotonic counter minting node-instance ids; reset alongside the board.
  const [nextNodeId, setNextNodeId] = useState(restored ? restored.nextNodeId : 0);
  // Monotonic counter minting persistent group ids, same pattern as
  // nextNodeId; reset alongside the board.
  const [nextGroupId, setNextGroupId] = useState(restored ? restored.nextGroupId : 0);
  // Currently selected node ids - the ad-hoc, transient selection. It
  // survives drags (so a clustered phrase can be moved repeatedly) and
  // clears on a plain click of empty board background. It is also the
  // staging area for persistent groups: "Group Selected" promotes a 2+
  // selection into a groupId-backed group that outlives the selection.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  // In-progress rubber-band rectangle in board coordinates
  // ({ x1, y1, x2, y2 }, normalized so x1 <= x2 and y1 <= y2), or null.
  const [marquee, setMarquee] = useState(null);

  const boardRef = useRef(null);
  // Measured pixel size per pinned node (node id -> { w, h }), captured once
  // by a callback ref at mount. A node's size never changes afterwards (its
  // text and badges are constant, and the selection ring is a box-shadow so
  // it adds no layout size), so one commit-time measurement is enough to
  // clamp drag bounds against the board edges and to hit-test the marquee.
  const [nodeSizes, setNodeSizes] = useState({});

  const registerNodeEl = (nodeId) => (el) => {
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setNodeSizes((prev) =>
      prev[nodeId]?.w === w && prev[nodeId]?.h === h
        ? prev
        : { ...prev, [nodeId]: { w, h } }
    );
  };

  const loadWords = () => {
    // Re-parsing is an explicit action, not a keystroke effect: auto-resetting
    // the bank while the user edits the input mid-solve would throw away work.
    setBankTokens(tokenize(input));
    setNodes([]);
    setNextNodeId(0);
    setNextGroupId(0);
    setNodeSizes({});
    setSelectedIds(new Set());
    setMarquee(null);
    setLoaded(true);
  };

  // Continuous auto-save: mirror the board state into localStorage whenever
  // it changes (the hook debounces the actual writes). Gated on `loaded` so
  // a never-used board doesn't write an empty snapshot; once words have been
  // loaded, every change - including Reset All's fresh state - becomes the
  // snapshot the next open resumes.
  useEffect(() => {
    if (!loaded) return;
    setSavedBoard({ input, nodes, nextNodeId, nextGroupId });
  }, [loaded, input, nodes, nextNodeId, nextGroupId, setSavedBoard]);

  // Spawn a new independent instance of a bank word on the board. The bank
  // itself is untouched - placing a word never consumes it.
  const placeNode = (token, x, y) => {
    setNodes((prev) => [...prev, { id: nextNodeId, token, x, y, groupId: null }]);
    setNextNodeId((prev) => prev + 1);
  };

  // Click-to-place fallback for anyone who prefers clicking over dragging:
  // pins cascade diagonally in wrapping columns so successive clicks never
  // stack exactly on top of each other.
  const placeFromBank = (token) => {
    const rect = boardRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 720;
    const cols = Math.max(1, Math.floor((width - 48) / 130));
    const i = nodes.length;
    const x = 24 + (i % cols) * 130;
    const y = 24 + (Math.floor(i / cols) % 8) * 52 + (i % cols) * 4;
    placeNode(token, x, y);
  };

  const handleBoardDrop = (e) => {
    e.preventDefault();
    const id = Number(e.dataTransfer.getData('text/plain'));
    const token = bankTokens.find((item) => item.id === id);
    if (!token) return;
    const rect = boardRef.current.getBoundingClientRect();
    // Offset so the chip lands roughly centered under the cursor.
    const x = clamp(
      e.clientX - rect.left - APPROX_NODE_WIDTH / 2,
      0,
      rect.width - APPROX_NODE_WIDTH
    );
    const y = clamp(
      e.clientY - rect.top - APPROX_NODE_HEIGHT / 2,
      0,
      rect.height - APPROX_NODE_HEIGHT
    );
    placeNode(token, x, y);
  };

  // Delete placed instances by node id. Other copies of the same words and
  // the bank entries are unaffected - the bank was never depleted. Removed
  // nodes also leave the selection so a later action cannot reference a
  // ghost, and any group left with fewer than 2 members dissolves. Shared by
  // the per-node "x" button and the Backspace/Delete batch path.
  const removeNodes = useCallback((idsToRemove) => {
    setNodes((prev) =>
      dissolveUndersizedGroups(prev.filter((item) => !idsToRemove.has(item.id)))
    );
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => !idsToRemove.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, []);

  const removeNode = (nodeId) => removeNodes(new Set([nodeId]));

  // Backspace/Delete removes every selected pin at once. Guarded so typing
  // in the Scrambled Words textarea (or any other editable element) never
  // deletes board nodes, and preventDefault stops Backspace from triggering
  // browser back-navigation in embedding contexts. Escape clears the
  // selection (same as clicking empty board background); it's non-destructive
  // so it works regardless of focus, and is a pure no-op when nothing is
  // selected so normal Escape behavior elsewhere isn't suppressed.
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        if (selectedIds.size === 0) return;
        setSelectedIds(new Set());
        return;
      }
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      if (selectedIds.size === 0) return;
      const active = document.activeElement;
      const isEditable =
        active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable);
      if (isEditable) return;
      e.preventDefault();
      removeNodes(selectedIds);
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds, removeNodes]);

  // Promote the current 2+ selection into a persistent group under a fresh
  // groupId, overwriting any group membership the selected nodes had. If
  // that raid left some other group with fewer than 2 members, the survivor
  // is ungrouped too.
  const groupSelected = () => {
    if (selectedIds.size < 2) return;
    setNodes((prev) =>
      dissolveUndersizedGroups(
        prev.map((item) =>
          selectedIds.has(item.id) ? { ...item, groupId: nextGroupId } : item
        )
      )
    );
    setNextGroupId((prev) => prev + 1);
  };

  // Dissolve one group: clear groupId on all its members. The pins stay on
  // the board where they are.
  const ungroup = (groupId) => {
    setNodes((prev) =>
      prev.map((item) =>
        item.groupId === groupId ? { ...item, groupId: null } : item
      )
    );
  };

  // A tap on a node toggles just that node's membership in the selection,
  // without clobbering the rest of it - the hand-editing complement to
  // rubber-band select: sweep a rough cluster, then click individual words
  // to add or remove them one at a time.
  const toggleNodeSelection = (nodeId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  };

  /**
   * Shared drag engine for every "move a set of pins with the mouse" case:
   * freeform repositioning via plain mouse events rather than native HTML5
   * drag-and-drop, because document-level mousemove/mouseup listeners give
   * smooth continuous {x, y} updates where the native drag system only
   * reports coarse positions and paints a ghost image. Every node in
   * draggedIds gets the same delta from its own captured start position
   * (relative offsets preserved), each clamped to the board bounds
   * independently. A sub-4px movement counts as a tap: nothing moves and
   * the optional onTap callback fires instead; onFirstDrag fires once when
   * movement crosses that threshold.
   */
  const startDragMove = (e, draggedIds, { onFirstDrag, onTap } = {}) => {
    const rect = boardRef.current.getBoundingClientRect();
    const startPositions = new Map(
      nodes
        .filter((item) => draggedIds.has(item.id))
        .map((item) => [item.id, { x: item.x, y: item.y }])
    );
    let moved = false;
    const onMove = (ev) => {
      if (
        !moved &&
        Math.abs(ev.clientX - e.clientX) < 4 &&
        Math.abs(ev.clientY - e.clientY) < 4
      ) {
        return;
      }
      if (!moved) onFirstDrag?.();
      moved = true;
      const dx = ev.clientX - e.clientX;
      const dy = ev.clientY - e.clientY;
      setNodes((prev) =>
        prev.map((item) => {
          const start = startPositions.get(item.id);
          if (!start) return item;
          const size = nodeSizes[item.id];
          const w = size?.w ?? APPROX_NODE_WIDTH;
          const h = size?.h ?? APPROX_NODE_HEIGHT;
          return {
            ...item,
            x: clamp(start.x + dx, 0, rect.width - w),
            y: clamp(start.y + dy, 0, rect.height - h)
          };
        })
      );
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (!moved) onTap?.();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  /**
   * Mouse-down on a pin. If the grabbed node belongs to a persistent group,
   * the whole group moves together - a group outranks the transient
   * selection as a "move together" unit. Otherwise, if the node is part of
   * a 2+ node selection, the entire selection moves. Grabbing an ungrouped,
   * unselected node moves just that node and replaces the selection with it
   * once a real drag starts; a tap toggles the node's selection membership.
   */
  const beginNodeDrag = (e, nodeId) => {
    if (e.button !== 0) return;
    // Let the remove button handle its own clicks.
    if (e.target.closest('button')) return;
    e.preventDefault();
    const grabbed = nodes.find((item) => item.id === nodeId);
    if (!grabbed) return;
    const groupMemberIds =
      grabbed.groupId != null
        ? new Set(
            nodes
              .filter((item) => item.groupId === grabbed.groupId)
              .map((item) => item.id)
          )
        : null;
    const groupDrag =
      groupMemberIds != null || (selectedIds.has(nodeId) && selectedIds.size >= 2);
    const draggedIds =
      groupMemberIds ?? (groupDrag ? selectedIds : new Set([nodeId]));
    startDragMove(e, draggedIds, {
      onFirstDrag: () => {
        // A real drag of an unselected node claims the selection for itself,
        // matching file-manager convention: what you grab is what's selected.
        if (!groupDrag) setSelectedIds(new Set([nodeId]));
      },
      onTap: () => toggleNodeSelection(nodeId)
    });
  };

  /**
   * Mouse-down on a group's boundary box (its padding area, between the
   * dashed border and the member pins): drag the whole group, same as
   * grabbing one of its member pins would. A tap deliberately does nothing -
   * the box has no per-node selection to toggle, and clobbering selectedIds
   * from here would surprise more than it helps.
   */
  const beginGroupDrag = (e, groupId) => {
    if (e.button !== 0) return;
    // Let the ungroup button handle its own clicks.
    if (e.target.closest('button')) return;
    e.preventDefault();
    const memberIds = new Set(
      nodes.filter((item) => item.groupId === groupId).map((item) => item.id)
    );
    if (memberIds.size === 0) return;
    startDragMove(e, memberIds);
  };

  /**
   * Rubber-band selection: mouse-down on empty board background and drag
   * draws a rectangle; on release, every node whose box intersects it (AABB
   * overlap test) becomes the new selection. A plain click on empty
   * background (sub-4px, the same tap threshold as node drags) clears the
   * selection instead, without moving anything.
   */
  const beginMarquee = (e) => {
    if (e.button !== 0) return;
    // Only starts on the board background itself - mouse-downs on nodes hit
    // beginNodeDrag and bubble here with a different target.
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    const rect = boardRef.current.getBoundingClientRect();
    const startX = e.clientX - rect.left;
    const startY = e.clientY - rect.top;
    let moved = false;
    let last = { x1: startX, y1: startY, x2: startX, y2: startY };
    const onMove = (ev) => {
      if (
        !moved &&
        Math.abs(ev.clientX - e.clientX) < 4 &&
        Math.abs(ev.clientY - e.clientY) < 4
      ) {
        return;
      }
      moved = true;
      const curX = clamp(ev.clientX - rect.left, 0, rect.width);
      const curY = clamp(ev.clientY - rect.top, 0, rect.height);
      last = {
        x1: Math.min(startX, curX),
        y1: Math.min(startY, curY),
        x2: Math.max(startX, curX),
        y2: Math.max(startY, curY)
      };
      setMarquee(last);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setMarquee(null);
      if (!moved) {
        setSelectedIds(new Set());
        return;
      }
      const hitIds = nodes
        .filter((node) => {
          const size = nodeSizes[node.id];
          const w = size?.w ?? APPROX_NODE_WIDTH;
          const h = size?.h ?? APPROX_NODE_HEIGHT;
          return (
            node.x < last.x2 &&
            node.x + w > last.x1 &&
            node.y < last.y2 &&
            node.y + h > last.y1
          );
        })
        .map((node) => node.id);
      setSelectedIds(new Set(hitIds));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const allWords = input.split(/\s+/).filter(Boolean);
  const uniqueCount = new Set(
    allWords.map((word) => normalizeWord(word)).filter(Boolean)
  ).size;
  const repeats = repeatedWords(input);

  // Purely informational: how many copies of each bank word are currently on
  // the board (token id -> count). Never disables anything.
  const placedCounts = nodes.reduce((acc, node) => {
    acc[node.token.id] = (acc[node.token.id] || 0) + 1;
    return acc;
  }, {});

  // Bounding rectangle per persistent group, from member positions plus
  // measured sizes (same AABB math as marquee hit-testing), padded so the
  // dashed boundary doesn't hug the pins. Recomputed every render, so it
  // follows live while a group is dragged.
  const groupBoundsById = new Map();
  nodes.forEach((node) => {
    if (node.groupId == null) return;
    const size = nodeSizes[node.id];
    const w = size?.w ?? APPROX_NODE_WIDTH;
    const h = size?.h ?? APPROX_NODE_HEIGHT;
    const bounds = groupBoundsById.get(node.groupId);
    if (!bounds) {
      groupBoundsById.set(node.groupId, {
        x1: node.x,
        y1: node.y,
        x2: node.x + w,
        y2: node.y + h
      });
    } else {
      bounds.x1 = Math.min(bounds.x1, node.x);
      bounds.y1 = Math.min(bounds.y1, node.y);
      bounds.x2 = Math.max(bounds.x2, node.x + w);
      bounds.y2 = Math.max(bounds.y2, node.y + h);
    }
  });
  const groupRects = [...groupBoundsById.entries()].map(([groupId, bounds]) => {
    const left = Math.max(0, bounds.x1 - GROUP_PADDING);
    const top = Math.max(0, bounds.y1 - GROUP_PADDING);
    return {
      groupId,
      left,
      top,
      width: bounds.x2 + GROUP_PADDING - left,
      height: bounds.y2 + GROUP_PADDING - top
    };
  });

  const badges = (token) => (
    <>
      {token.capitalized && (
        <span
          title="Starts with a capital - possible proper noun or sentence start"
          className="ml-1 px-1 rounded-sm text-[10px] leading-4 bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
        >
          A
        </span>
      )}
      {token.punctuation && (
        <span
          title="Trailing punctuation - possible clause or sentence boundary"
          className="ml-1 px-1 rounded-sm text-[10px] leading-4 bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300"
        >
          {token.punctuation}
        </span>
      )}
    </>
  );

  return (
    <div className="h-full flex flex-col bg-os-background p-6 overflow-y-auto">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Puzzle size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            Sentence Builder
          </h3>
        </div>

        {/* Scrambled input */}
        <div className="p-4 bg-os-card border border-os-border rounded-sm space-y-3">
          <label className="block text-sm text-os-text-primary">
            Scrambled Words
          </label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste the shuffled, space-separated word list..."
            className="w-full h-28 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted text-sm resize-none focus:outline-hidden focus:ring-2 focus:ring-os-blue"
          />
          <div className="grid grid-cols-2 gap-4">
            <div className="p-3 bg-os-card border border-os-border rounded-sm">
              <div className="text-sm text-os-text-secondary">Total Words</div>
              <div className="text-2xl font-bold text-os-text-primary mt-1">
                {allWords.length.toLocaleString()}
              </div>
            </div>
            <div className="p-3 bg-os-card border border-os-border rounded-sm">
              <div className="text-sm text-os-text-secondary">Unique Words</div>
              <div className="text-2xl font-bold text-os-text-primary mt-1">
                {uniqueCount.toLocaleString()}
              </div>
            </div>
          </div>
          <button
            onClick={loadWords}
            disabled={allWords.length === 0}
            className="btn btn-primary px-4 py-2 text-sm"
          >
            Load Words
          </button>
        </div>

        {/* Repeated words - a structural clue (three "and"s suggests a list) */}
        <div className="p-4 bg-os-card border border-os-border rounded-sm space-y-3">
          <div className="text-sm font-medium text-os-text-primary">
            Repeated Words
          </div>
          {repeats.length === 0 ? (
            <div className="text-sm text-os-text-secondary">
              No repeated words
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {repeats.map(([word, count]) => (
                <span
                  key={word}
                  className="px-2 py-1 bg-os-card border border-os-border rounded-sm text-sm text-os-text-primary"
                >
                  {word}{' '}
                  <span className="text-os-text-secondary">&times;{count}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        {loaded && (
          <>
            {/* Word bank, sorted by word type. A permanent source, not a
                depleting pool: clicking (cascade placement) or dragging a
                chip spawns a new copy on the board and the chip stays here,
                so the same word can be placed any number of times. */}
            <div className="p-4 bg-os-card border border-os-border rounded-sm space-y-3">
              <div className="text-sm font-medium text-os-text-primary">
                Word Bank
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {CATEGORIES.map((category) => {
                  const words = bankTokens.filter(
                    (token) => token.category === category.id
                  );
                  if (words.length === 0) return null;
                  return (
                    <div key={category.id} className="space-y-2">
                      <div className="text-xs font-medium text-os-text-secondary">
                        {category.label} ({words.length})
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {words.map((token) => (
                          <button
                            key={token.id}
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.setData(
                                'text/plain',
                                String(token.id)
                              );
                              e.dataTransfer.effectAllowed = 'copy';
                            }}
                            onClick={() => placeFromBank(token)}
                            title="Click to pin a copy to the board, or drag one to an exact spot - place the same word as many times as you like"
                            className={`bg-os-card border rounded-sm px-2 py-1 text-sm hover:bg-os-card-secondary transition-colors cursor-grab ${category.chip}${(placedCounts[token.id] ?? 0) >= 1 ?' opacity-50':''}`}
                          >
                            {token.text}
                            {badges(token)}
                            {(placedCounts[token.id] ?? 0) >= 2 && (
                              <span
                                title={`${placedCounts[token.id]} copies currently on the board`}
                                className="ml-1 text-[10px] align-super text-os-text-secondary"
                              >
                                &times;{placedCounts[token.id]}
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* The Board - a war-room corkboard. Words are pinned anywhere
                and dragged freely; rubber-band select a cluster to move it
                as one, click individual pins to toggle them in or out of
                the selection, promote a 2+ selection into a persistent
                group (dashed boundary, drags as a unit, survives clicking
                away), and duplicate copies of a word let several candidate
                arrangements coexist. Backspace/Delete removes the selected
                pins. */}
            <div className="p-4 bg-os-card border border-os-border rounded-sm space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="text-sm font-medium text-os-text-primary">
                  The Board
                </div>
                <div className="flex items-center gap-2">
                  {selectedIds.size >= 2 && (
                    <button
                      onClick={groupSelected}
                      title="Turn the selected words into a persistent group that moves together"
                      className="flex items-center gap-1 px-3 py-1.5 bg-os-card text-os-text-primary text-xs rounded-sm border border-os-border hover:bg-os-card-secondary transition-colors"
                    >
                      Group Selected
                    </button>
                  )}
                  <button
                    onClick={loadWords}
                    title="Clear every pinned word and group off the board"
                    className="flex items-center gap-1 px-3 py-1.5 bg-os-card text-os-text-primary text-xs rounded-sm border border-os-border hover:bg-os-card-secondary transition-colors"
                  >
                    Reset All
                  </button>
                </div>
              </div>
              <div className="text-xs text-os-text-secondary">
                Drag or click bank words to pin copies here. Select 2+ pins to
                group them; Backspace removes selected pins.
              </div>
              <div
                ref={boardRef}
                onMouseDown={beginMarquee}
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleBoardDrop}
                className="relative min-h-[560px] bg-os-background border border-os-border rounded-sm overflow-hidden"
              >
                {nodes.length === 0 && (
                  <div className="absolute inset-0 flex items-center justify-center text-sm text-os-text-secondary pointer-events-none">
                    Drag or click words from the bank to pin copies here - the
                    bank never runs out
                  </div>
                )}

                {/* Persistent group boundaries, painted behind the pins.
                    The box itself is a drag surface: grabbing its padding
                    area moves the whole group, same as grabbing a member
                    pin. Pins render after (above) it, so pin drags still
                    land on the pins, and beginMarquee's own-target guard
                    keeps box mousedowns from starting a marquee. Positions
                    are inline, like the pins below: they are computed
                    per render, not a fixed utility class. */}
                {groupRects.map((group) => {
                  const style = GROUP_STYLES[group.groupId % GROUP_STYLES.length];
                  return (
                    <div
                      key={`group-${group.groupId}`}
                      onMouseDown={(e) => beginGroupDrag(e, group.groupId)}
                      style={{
                        position: 'absolute',
                        left: group.left,
                        top: group.top,
                        width: group.width,
                        height: group.height
                      }}
                      title="Drag to move the whole group"
                      className={`rounded-sm border-2 border-dashed cursor-move select-none ${style.box}`}
                    >
                      <button
                        onClick={() => ungroup(group.groupId)}
                        title="Ungroup these words (the pins stay on the board)"
                        style={{ position: 'absolute', top: -10, right: -10 }}
                        className={`pointer-events-auto flex items-center justify-center w-5 h-5 rounded-full bg-os-card border hover:bg-os-card-secondary transition-colors ${style.button}`}
                      >
                        <Ungroup size={10} />
                      </button>
                    </div>
                  );
                })}

                {nodes.map((node) => (
                  // position is set inline together with left/top: the pin's
                  // place is computed per render, and an inline style beats
                  // any stylesheet rule, so the pin is guaranteed freely
                  // positioned (a global rule once un-positioned pins that
                  // carried a title; index.css explains why none may return).
                  <div
                    key={node.id}
                    ref={registerNodeEl(node.id)}
                    onMouseDown={(e) => beginNodeDrag(e, node.id)}
                    style={{ position: 'absolute', left: node.x, top: node.y }}
                    title="Drag to move (a grouped word drags its whole group, a selected word the whole selection) - click to toggle it in or out of the selection"
                    className={`flex items-center gap-1.5 bg-os-card border rounded px-2 py-1 text-sm shadow-xs cursor-move select-none ${
 CHIP_CLASS_BY_CATEGORY[node.token.category]
 } ${selectedIds.has(node.id) ?'ring-2 ring-os-blue':''}`}
                  >
                    <span className="whitespace-nowrap">
                      {node.token.text}
                      {badges(node.token)}
                    </span>
                    <button
                      onClick={() => removeNode(node.id)}
                      title="Remove this copy from the board"
                      className="p-0.5 text-os-text-secondary hover:text-os-text-primary transition-colors"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}

                {marquee && (
                  <div
                    style={{
                      position: 'absolute',
                      left: marquee.x1,
                      top: marquee.y1,
                      width: marquee.x2 - marquee.x1,
                      height: marquee.y2 - marquee.y1
                    }}
                    className="bg-os-blue/10 border border-os-blue pointer-events-none"
                  />
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
