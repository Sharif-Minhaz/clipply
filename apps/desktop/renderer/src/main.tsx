import { createRoot } from 'react-dom/client';
import { applyTheme, ClipplyProvider, loadTheme } from '@clipply/ui';

import './app.css';
import { App } from './App';
import { desktopClient } from './client';

applyTheme(loadTheme());

createRoot(document.getElementById('root')!).render(
  <ClipplyProvider client={desktopClient}>
    <App />
  </ClipplyProvider>,
);
