import { renderSVG } from 'uqr';

/** Render data as an inline QR SVG string (theme-aware via currentColor). */
export function qrSvg(data: string): string {
  return renderSVG(data, {
    ecc: 'M',
    border: 2,
    blackColor: 'currentColor',
    whiteColor: 'transparent',
  });
}
