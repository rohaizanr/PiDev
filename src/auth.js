// Telegram identity policy. Fail-closed: no configured owner IDs => nobody.

/** @returns {{ valid: string[], invalid: string[] }} */
export function parseAllowedUserIds(raw) {
  const valid = [];
  const invalid = [];
  for (const part of String(raw ?? '').split(',')) {
    const s = part.trim();
    if (!s) continue;
    if (/^[1-9]\d{0,19}$/.test(s)) { if (!valid.includes(s)) valid.push(s); } else invalid.push(s);
  }
  return { valid, invalid };
}

/**
 * Is this Telegram user an owner? Usernames are never accepted: only numeric IDs.
 * @param {string|number|undefined|null} userId
 * @param {string[]} allowed
 */
export function isAuthorizedUser(userId, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) return false;
  if (userId === undefined || userId === null) return false;
  const id = String(userId);
  if (!/^[1-9]\d{0,19}$/.test(id)) return false;
  return allowed.includes(id);
}

/**
 * Full update policy (mirrors what OpenACP's Telegram adapter + PiDev middleware
 * enforce together): the update must come from the single configured private
 * forum supergroup AND from an allowlisted user. Private 1:1 chats, other
 * groups, channels and inline queries (no chat) are rejected.
 *
 * @param {{ chatId?: number|string|null, chatType?: string|null, userId?: string|number|null, isBot?: boolean }} update
 * @param {{ chatId: number|null, allowedUserIds: string[] }} cfg
 */
export function isAuthorizedUpdate(update, cfg) {
  if (!cfg || cfg.chatId === null || cfg.chatId === undefined) return false;
  if (!update || update.chatId === undefined || update.chatId === null) return false; // inline queries etc.
  if (update.chatType !== 'supergroup') return false;
  if (Number(update.chatId) !== Number(cfg.chatId)) return false;
  if (update.isBot) return false;
  return isAuthorizedUser(update.userId, cfg.allowedUserIds);
}
