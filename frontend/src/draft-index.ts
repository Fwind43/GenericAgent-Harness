import { useSyncExternalStore } from 'react';
import { attachmentDrafts } from './attachment-drafts';
import { sessionDrafts } from './session-drafts';

// Unsent composer content (text or attachments) per session, for list badges.
let version = 0, cachedVersion = -1, cached: ReadonlySet<string> = new Set();
const bump = () => { version++; };
sessionDrafts.subscribe(bump);
attachmentDrafts.subscribe(bump);
const subscribe = (listener: () => void) => {
  const a = sessionDrafts.subscribe(listener), b = attachmentDrafts.subscribe(listener);
  return () => { a(); b(); };
};
const snapshot = () => {
  if (cachedVersion !== version) {
    cachedVersion = version;
    cached = new Set([...sessionDrafts.ids(), ...attachmentDrafts.ids()]);
  }
  return cached;
};
export const draftSessions = snapshot;
export const useDraftSessions = () => useSyncExternalStore(subscribe, snapshot);
