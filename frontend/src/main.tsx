import { createRoot } from 'react-dom/client';
import { App } from './App';
import { plugins } from './plugin-runtime';
import { registerBuiltins } from './plugins';
import './host.css';

window.GAH = plugins.sdk;
registerBuiltins();
const container = document.getElementById('root');
if (!container) throw new Error('Missing React host root');
const root = createRoot(container);
root.render(<App />);
if (import.meta.hot) import.meta.hot.dispose(() => { root.unmount(); plugins.dispose(); });
