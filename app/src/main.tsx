import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import App from './App';
import { bootSession } from './state/session';

void bootSession().finally(() => {
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
});
