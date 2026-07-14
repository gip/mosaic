import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** A centered overlay dialog. Closes on backdrop click, the ✕ button, or Escape by default. */
export default function Modal({
  title,
  onClose,
  dismissible = true,
  closeButtonOnly = false,
  children,
}: {
  title: ReactNode
  onClose: () => void
  dismissible?: boolean
  closeButtonOnly?: boolean
  children: ReactNode
}) {
  const modalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!dismissible || closeButtonOnly) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeButtonOnly, dismissible, onClose])

  function onBackdropClick() {
    if (!dismissible) return
    if (!closeButtonOnly) {
      onClose()
      return
    }

    // Restart the attention animation even when the backdrop is clicked repeatedly.
    const modal = modalRef.current
    if (!modal) return
    modal.classList.remove('modal-attention')
    void modal.offsetWidth
    modal.classList.add('modal-attention')
  }

  return createPortal(
    <div className="modal-overlay" onClick={dismissible ? onBackdropClick : undefined}>
      <div
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        onAnimationEnd={(event) => {
          if (event.currentTarget === event.target) event.currentTarget.classList.remove('modal-attention')
        }}
        onClick={(e) => e.stopPropagation()}
      >
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
