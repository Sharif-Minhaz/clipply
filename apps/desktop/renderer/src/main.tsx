import { createRoot } from 'react-dom/client';
import { ClipplyProvider } from '@clipply/ui';

import './app.css';
import { App } from './App';
import { desktopClient } from './client';

createRoot(document.getElementById('root')!).render(
  <ClipplyProvider client={desktopClient}>
    <App />
  </ClipplyProvider>,
);
