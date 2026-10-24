import React from 'react';
import ReactDOM from 'react-dom/client';
import App, { ThemedRoot } from './App';
import { StoreProvider } from './store';
import { ActionsProvider } from './components/actions';
import CloseGuard from './components/CloseGuard';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StoreProvider>
      <ThemedRoot>
        <ActionsProvider>
          <App />
          <CloseGuard />
        </ActionsProvider>
      </ThemedRoot>
    </StoreProvider>
  </React.StrictMode>,
);
