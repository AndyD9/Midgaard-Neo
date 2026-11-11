/**
 * @file Bouton, dans l'idiome shadcn/ui : les variantes sont décrites par
 * `class-variance-authority` plutôt que par des conditions dans le rendu, et
 * `asChild` permet de rendre un `<a>` avec l'apparence d'un bouton.
 *
 * Les composants shadcn/ui sont recopiés dans le projet plutôt qu'installés :
 * c'est le modèle de la bibliothèque. Ceux d'ici sont réduits à ce que le
 * dashboard utilise réellement.
 */
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ' +
    'transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent ' +
    'disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-accent text-white hover:opacity-90',
        outline: 'border border-border bg-surface hover:bg-canvas',
        ghost: 'hover:bg-canvas',
        danger: 'border border-danger/40 text-danger hover:bg-danger/10',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 px-3 text-xs',
        icon: 'size-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

/** Bouton. `asChild` délègue le rendu à l'enfant tout en gardant les styles. */
export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'button'
  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

export { buttonVariants }
