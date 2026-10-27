// Public module for plugin sources: `import { ... } from '@gah/sdk'`.
// Plugin bundles treat it as external and read the same values from window.GAH.
import type * as ReactNS from 'react';
import type * as ReactDOMNS from 'react-dom';
import type * as JsxRuntimeNS from 'react/jsx-runtime';
import { plugins } from './plugin-runtime';
import type { BrowserSDK, PluginSetup, ReactPlugin } from './sdk';

export { host, useHost } from './store';
export { T, save, saved, errorText } from './i18n';
export { Icon, Modal, PluginSlot, SettingsPanel, useOperation, matches, alertDialog, confirmDialog, promptDialog } from './plugin-kit';
export type { AskOptions } from './plugin-kit';
export type * from './types';
export type { PluginAPI, SlotName, Cleanup, Interceptor, PluginSetup, ReactPlugin, DomChild } from './sdk';
export const define = (name: string, setup: PluginSetup) => plugins.sdk.define(name, setup);
export const defineReact = (name: string, component: ReactPlugin) => plugins.sdk.defineReact(name, component);

type Kit = typeof import('./gah-sdk');
export type GAHGlobal = BrowserSDK & Kit & { React: typeof ReactNS; ReactDOM: typeof ReactDOMNS; jsxRuntime: typeof JsxRuntimeNS };
declare global { interface Window { GAH: GAHGlobal } }
