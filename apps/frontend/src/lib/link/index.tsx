/**
 * Same-origin anchor that drives the SPA router. External links (other
 * origins, `target="_blank"`, modifier-clicks) fall through to the
 * browser's native behaviour — don't hijack those.
 *
 * Split into its own file so `router.ts` stays component-free and
 * Vite's react-refresh plugin doesn't complain about mixed exports.
 */

import {
  forwardRef,
  useCallback,
  type AnchorHTMLAttributes,
  type MouseEvent,
} from 'react'
import { navigate } from '../router'

export const Link = forwardRef<
  HTMLAnchorElement,
  AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }
>(function Link({ to, onClick, ...rest }, ref) {
  const handleClick = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e)
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey ||
        rest.target === '_blank'
      ) {
        return
      }
      e.preventDefault()
      navigate(to)
    },
    [to, onClick, rest.target],
  )
  return <a ref={ref} {...rest} href={to} onClick={handleClick} />
})
