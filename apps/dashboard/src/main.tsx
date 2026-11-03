import React from 'react';
import ReactDOM from 'react-dom/client';
import { AuthGate } from './Auth';
import './styles.css';
import './theme.css';
import './motion.css';
import { initializeTheme } from './useTheme';

initializeTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><AuthGate/></React.StrictMode>);
