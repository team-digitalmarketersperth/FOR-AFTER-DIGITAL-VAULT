import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

// For After buttons follow the WordPress CTAs (verified): fully rounded pills,
// Figtree semibold, aubergine with petal text (primary) or petal with aubergine
// text (secondary), ~46px tall with 30px side padding.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap transition-colors outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:outline-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[18px]",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover",
        secondary: "bg-secondary text-secondary-foreground hover:bg-brand-lilac-grey/70",
        outline:
          "border border-border-strong bg-surface text-foreground hover:bg-surface-muted aria-expanded:bg-surface-muted",
        ghost: "text-foreground-secondary hover:bg-surface-muted hover:text-foreground aria-expanded:bg-surface-muted",
        destructive: "bg-danger text-white hover:bg-danger/90",
        link: "rounded-sm px-0 text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-7 text-[15px]",
        xs: "h-7 px-3 text-xs",
        sm: "h-9 px-5 text-sm",
        lg: "h-12 px-8 text-base",
        icon: "size-11",
        "icon-xs": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-9",
        "icon-lg": "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
