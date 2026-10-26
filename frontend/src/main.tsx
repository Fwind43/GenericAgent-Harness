import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as jsxRuntime from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { plugins } from './plugin-runtime';
import * as kit from './gah-sdk';
import './host.css';

// Plugin bundles (ga_harness/plugins/*/client.js) import these through window.GAH.
window.GAH = { ...plugins.sdk, ...kit, React, ReactDOM, jsxRuntime };
const container = document.getElementById('root');
if (!container) throw new Error('Missing React host root');
const root = createRoot(container);
root.render(<App />);
if (import.meta.hot) import.meta.hot.dispose(() => { root.unmount(); plugins.dispose(); });
