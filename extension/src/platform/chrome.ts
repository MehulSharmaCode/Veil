// Platform adapter: the only module that touches `chrome.*`. Keeps browser specifics in one place
// (a later Firefox/offscreen port, or per-origin programmatic injection, changes only this file).

import type { ContentRequest, ContentResponse } from '../shared/messages';

export interface ActiveTab {
  id: number;
  url: string;
  windowId: number;
}

/** Service worker: open the side panel when the toolbar icon is clicked. */
export function configureSidePanelOnActionClick(): void {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

export function onInstalledOrStartup(fn: () => void): void {
  chrome.runtime.onInstalled.addListener(fn);
  chrome.runtime.onStartup.addListener(fn);
}

/** The active tab in the window the side panel belongs to. URL is visible only for host-permitted origins. */
export async function getActiveTab(): Promise<ActiveTab | null> {
  const win = await chrome.windows.getCurrent();
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  if (!tab?.id || !tab.url) return null;
  return { id: tab.id, url: tab.url, windowId: tab.windowId };
}

export function onActiveTabChanged(fn: () => void): () => void {
  const a = () => fn();
  const u = (_id: number, info: chrome.tabs.OnUpdatedInfo) => {
    if (info.status === 'complete' || info.url) fn();
  };
  chrome.tabs.onActivated.addListener(a);
  chrome.tabs.onUpdated.addListener(u);
  return () => {
    chrome.tabs.onActivated.removeListener(a);
    chrome.tabs.onUpdated.removeListener(u);
  };
}

export async function sendToTab<R = ContentResponse>(tabId: number, msg: ContentRequest): Promise<R> {
  return (await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 })) as R;
}

/**
 * The single content-script injection point. v0.1: the script is declared in the manifest for
 * localhost; this pings it and, if it's missing (e.g. extension reloaded without reloading the tab),
 * injects it programmatically. Later milestones switch this to user-granted origins.
 */
export async function ensureContentScript(tabId: number): Promise<boolean> {
  try {
    const r = await sendToTab<{ ok: boolean }>(tabId, { type: 'ping' });
    if (r?.ok) return true;
  } catch {
    /* not present */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] });
    const r = await sendToTab<{ ok: boolean }>(tabId, { type: 'ping' });
    return !!r?.ok;
  } catch {
    return false;
  }
}

/** Content script side: register the request handler (async responses supported). */
export function onContentRequest(handler: (msg: ContentRequest) => Promise<ContentResponse>): void {
  chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || sender.tab) return false; // only from our extension pages
    handler(msg as ContentRequest).then(sendResponse, (e: unknown) =>
      sendResponse({ ok: false, error: e instanceof Error ? e.name : 'error' } as ContentResponse),
    );
    return true;
  });
}

export function extensionVersion(): string {
  return chrome.runtime.getManifest().version;
}
