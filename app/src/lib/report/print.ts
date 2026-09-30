// Export as PDF: the report is printed from the app's own window, and the print dialog's PDF
// menu has Save as PDF. Tauri 2 has no print-to-PDF of its own, only the webview's print
// (window.print(), which on macOS goes through the shell: capability core:webview:allow-print).
// The report's body and styles are put in the page, hidden on screen and the only thing printed,
// with every step open. They stay until the next print or until the report screen closes
// (removePrinted), because the macOS print sheet renders the page after print() returns.
import { printableParts } from '.';

export const PRINT_ID = 'bp-print-report';

export function removePrinted(): void {
  document.getElementById(PRINT_ID)?.remove();
  document.getElementById(`${PRINT_ID}-style`)?.remove();
}

export async function printReport(html: string): Promise<void> {
  const { css, body } = printableParts(html);
  removePrinted();
  const style = document.createElement('style');
  style.id = `${PRINT_ID}-style`;
  style.textContent = `${css}
@media screen { #${PRINT_ID} { display: none !important; } }
@media print {
  body > *:not(#${PRINT_ID}) { display: none !important; }
  html, body { height: auto !important; min-height: 0 !important; overflow: visible !important; background: #fff !important; }
  #${PRINT_ID} { display: block !important; }
}`;
  const holder = document.createElement('div');
  holder.id = PRINT_ID;
  holder.innerHTML = body;          // the template's output: every value in it is escaped
  document.head.appendChild(style);
  document.body.appendChild(holder);
  await Promise.all([...holder.querySelectorAll('img')].map(i => i.decode?.().catch(() => undefined)));
  await Promise.resolve(window.print());
}
