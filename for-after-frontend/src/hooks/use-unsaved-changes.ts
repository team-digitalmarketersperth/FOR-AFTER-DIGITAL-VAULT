'use client';

import { useEffect } from 'react';

/**
 * Asks the browser to confirm leaving (reload, close, typed URL) while a form
 * has unsaved edits. In-app links are not intercepted (App Router has no
 * blocking API); form state survives while the page stays mounted.
 */
export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}
