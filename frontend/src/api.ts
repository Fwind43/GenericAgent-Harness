const serverSnapshots = new WeakSet<object>();

// Track wire objects, not a property copied by local {...state} updates. Plugins may
// use setState for local changes as well as HTTP responses; those must not be deduped.
export function markServerSnapshot<T>(value: T): T {
  if (value && typeof value === 'object' && '_snapshot_id' in value) serverSnapshots.add(value);
  return value;
}
export const isServerSnapshot = (value: object) => serverSnapshots.has(value);

// Each page tells the server which chat it shows, so several pages can show different chats.
const VIEW_KEY = 'gah.view';
let viewed = '';
try { viewed = sessionStorage.getItem(VIEW_KEY) ?? ''; } catch { /* storage unavailable */ }
export const viewing = () => viewed;
export function setViewing(id: string | null | undefined) {
  if (!id || id === viewed) return;
  viewed = id;
  try { sessionStorage.setItem(VIEW_KEY, id); } catch { /* storage unavailable */ }
}
export const viewHeaders = (): Record<string, string> => (viewed ? { 'X-GAH-Session': viewed } : {});

export async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? viewHeaders() : { 'Content-Type': 'application/json', ...viewHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body), signal,
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data ? String(data.error) : `HTTP ${response.status}`;
    throw new Error(message);
  }
  if (data === null) throw new Error('Invalid JSON response');
  // Some APIs wrap the host snapshot alongside their own result (e.g. model settings).
  if (typeof data === 'object' && 'state' in data) markServerSnapshot(data.state);
  return markServerSnapshot(data) as T;
}
