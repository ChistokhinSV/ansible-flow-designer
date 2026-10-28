import '@xyflow/react/dist/style.css';
import '@vscode/codicons/dist/codicon.css';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
