"use strict";

const { extractBoughtTokens } = require("./seed-discovery");

function nextCursor(response) {
  const payload = response?.data ?? response ?? {};
  const candidates = [
    payload?.next_cursor,
    payload?.nextCursor,
    payload?.next,
    payload?.cursor,
    response?.next_cursor,
    response?.nextCursor,
    response?.next,
  ];
  const cursor = candidates.find((value) => value !== undefined && value !== null && String(value).trim());
  return cursor == null ? null : String(cursor);
}

function mergeTokens(target, tokens) {
  for (const token of tokens) {
    const previous = target.get(token.address);
    if (!previous || Number(token.lastActivityAt || 0) > Number(previous.lastActivityAt || 0)) {
      target.set(token.address, token);
    }
  }
}

async function collectSeedHistory({
  walletAddress,
  fetchPage,
  startCursor = null,
  maxPages = 3,
  tokenLimit = 250,
} = {}) {
  if (!walletAddress) throw new Error("walletAddress is required");
  if (typeof fetchPage !== "function") throw new Error("fetchPage is required");

  const boundedPages = Math.max(1, Math.min(10, Math.floor(Number(maxPages) || 1)));
  const boundedTokens = Math.max(1, Math.min(1000, Math.floor(Number(tokenLimit) || 250)));
  const tokens = new Map();
  const initialCursor = startCursor == null || !String(startCursor).trim() ? null : String(startCursor);
  const seenCursors = new Set(initialCursor ? [initialCursor] : []);
  let cursor = initialCursor;
  let continuation = null;
  let pagesFetched = 0;

  while (pagesFetched < boundedPages && tokens.size < boundedTokens) {
    const response = await fetchPage({ walletAddress, cursor });
    pagesFetched += 1;
    mergeTokens(tokens, extractBoughtTokens(response, { walletAddress, limit: boundedTokens }));

    const next = nextCursor(response);
    if (!next || next === cursor || seenCursors.has(next)) {
      continuation = null;
      break;
    }
    seenCursors.add(next);
    continuation = next;
    cursor = next;
  }

  return {
    tokens: [...tokens.values()]
      .sort((a, b) => Number(b.lastActivityAt || 0) - Number(a.lastActivityAt || 0))
      .slice(0, boundedTokens),
    pagesFetched,
    startCursor: initialCursor,
    nextCursor: continuation,
    exhausted: continuation == null,
  };
}

module.exports = { collectSeedHistory, nextCursor, mergeTokens };
