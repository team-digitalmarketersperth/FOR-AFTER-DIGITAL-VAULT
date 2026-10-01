import * as React from "react"
import { cn } from "cn"

// Same treatment as Input (7px radius, strong border, aubergine focus), with
// generous line height for long, personal writing.
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-40 w-full rounded-sm border border-input bg-surface px-3.5 py-3 text-base leading-relaxed text-foreground transition-colors outline-none placeholder:text-foreground-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/15 disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-60 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/15",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
