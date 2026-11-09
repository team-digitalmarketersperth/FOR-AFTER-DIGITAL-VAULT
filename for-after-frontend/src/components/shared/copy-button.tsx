'use client';

import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

/** Copies only on click; the toast says honestly whether it worked. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="w-fit"
      onClick={() =>
        navigator.clipboard.writeText(value).then(
          () => toast('Copied'),
          () => toast("Couldn't copy. Select the text instead."),
        )
      }
    >
      <Copy aria-hidden strokeWidth={1.5} className="size-4" />
      {label}
    </Button>
  );
}
