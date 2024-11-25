const darkModeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
const localStorageDarkMode = localStorage.getItem('darkMode');

// Check if current window is one that should remain transparent
const isTransparentWindow = window.location.pathname === '/prev-recordings' || 
                          window.location.pathname === '/window-capture-occluder';

// Only apply dark background if not a transparent window
if (!isTransparentWindow) {
  // Check stored preference first, then system preference
  if (localStorageDarkMode === 'true' || (localStorageDarkMode === null && darkModeMediaQuery.matches)) {
    document.documentElement.classList.add('dark');
  }

  // Add base background color to prevent flash
  const style = document.createElement('style');
  style.textContent = `
    html.dark:not([data-transparent-window]) {
      background-color: #1E1E1E;
    }
    html.dark:not([data-transparent-window]) body {
      background-color: #1E1E1E;
    }
  `;
  document.head.appendChild(style);
}