import Modal from './ui/Modal';
import type { XamanRefs } from '../api';

export interface XamanPrompt { refs: XamanRefs; label: string }

export default function XamanPromptModal({ prompt, onClose }: { prompt: XamanPrompt; onClose: () => void }) {
  return (
    <Modal title={prompt.label} onClose={onClose}>
      <div className="qr-box qr-large"><img src={prompt.refs.qrPng} alt="Xaman signing QR code" /></div>
      <p className="tile-note">
        Scan with Xaman, or <a href={prompt.refs.deeplink} target="_blank" rel="noreferrer">open the request directly</a>.
      </p>
    </Modal>
  );
}
