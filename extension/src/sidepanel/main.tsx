import { createRoot } from 'react-dom/client';
import '../ui/theme.css';
import './sidepanel.css';
import { SidePanel } from './SidePanel';

createRoot(document.getElementById('root')!).render(<SidePanel />);
