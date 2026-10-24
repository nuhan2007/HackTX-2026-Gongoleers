import { createRoot } from 'react-dom/client';
import '../ui/theme.css';
import './options.css';
import { Options } from './Options';

createRoot(document.getElementById('root')!).render(<Options />);
