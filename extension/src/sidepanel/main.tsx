import { createRoot } from 'react-dom/client';
import '../ui/theme.css';
import './sidepanel.css';
import { ErrorBoundary } from './ErrorBoundary';
import { SidePanel } from './SidePanel';

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <SidePanel />
  </ErrorBoundary>,
);
