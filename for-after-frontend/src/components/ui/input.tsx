import * as React from "react"
import { cn } from "cn"

// WordPress form fields (verified): 7px radius, white, thin border, Figtree.
// The border uses --input (stronger than the site's hairline) so the control
// boundary meets WCAG 3:1; the focus ring is the brand aubergine.
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-11 w-full min-w-0 rounded-sm border border-input bg-surface px-3.5 text-base text-foreground transition-colors outline-none placeholder:text-foreground-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/15 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-60 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/15",
        className
      )}
      {...props}
    />
  )
}

export { Input }
