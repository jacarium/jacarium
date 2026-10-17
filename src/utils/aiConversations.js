/**
 * Conversation identities for Robin (src/components/AIChatPage.jsx) and the
 * AI side panel (src/components/common/AIChatSidebar.jsx).
 *
 * A conversation used to take `Date.now()` as its id: two created in the
 * same millisecond - the page's start-up creating its default chat twice -
 * shared one id, so both rows matched the current id and both showed as
 * active. New conversations take a UUID. Conversations stored by earlier
 * versions keep their numeric ids: they are read back as numbers (the
 * stored current id too), so `conv.id === currentConversationId` keeps
 * holding for old and new ids alike. Nothing orders conversations by id
 * (their order is the list's own).
 */
import { generateUUID } from './uuid.js';

/** A fresh, collision-free conversation id. */
export function newConversationId() {
  return generateUUID();
}

/**
 * The id read back from storage: a digits-only string is one of the old
 * numeric ids and becomes a number again; anything else is a UUID string;
 * nothing is null.
 */
export function parseConversationId(saved) {
  if (saved == null) return null;
  const text = String(saved);
  if (text === '') return null;
  return /^\d+$/.test(text) ? parseInt(text, 10) : text;
}

/** A new, empty conversation with `name` and `settings`. */
export function buildConversation({ name, settings }) {
  return {
    id: newConversationId(),
    name,
    messages: [],
    createdAt: new Date().toISOString(),
    settings,
  };
}
