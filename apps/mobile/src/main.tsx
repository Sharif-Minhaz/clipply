import { createRoot } from 'react-dom/client';
import { applyTheme, loadTheme } from '@clipply/ui';

import './app.css';
import { App } from './App';

applyTheme(loadTheme());
createRoot(document.getElementById('root')!).render(<App />);
