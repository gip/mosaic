import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** A centered overlay dialog. Closes on backdrop click, the ✕ button, or Escape. */
export default function Modal({
  title,
  onClose,
  dismissible = true,
  children,
}: {
  title: ReactNode
  onClose: () => void
  dismissible?: boolean
  children: ReactNode
}) {
  useEffect(() => {
    if (!dismissible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dismissible, onClose])

  return createPortal(
    <div className="modal-overlay" onClick={dismissible ? onClose : undefined}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          {dismissible && (
            <button type="button" className="btn-ghost btn-sm" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
