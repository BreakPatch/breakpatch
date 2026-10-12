// Export as PDF: the report is printed from the app's own window, and the print dialog's PDF
// menu has Save as PDF. Tauri 2 has no print-to-PDF of its own, only the webview's print
// (window.print(), which on macOS goes through the shell: capability core:webview:allow-print).
// The report's body and styles are put in the page, hidden on screen and the only thing printed,
// as printView has it: a test that passed is its summary, any other lists its steps with the one
// that failed open. They stay until the next print or until the report screen closes
// (removePrinted), because the macOS print sheet renders the page after print() returns.
//
// The print dialog names the PDF after the page's title: on macOS WebKit gives the print operation
// the main frame's title (document.title) as its job title when the shell starts it, and Save as
// PDF suggests that. So the title is the HTML export's file name while the report prints, and comes
// back on afterprint. On macOS window.print() is Tauri's call to the shell, which needn't fire
// afterprint, so it also comes back when the printed report is removed, or a while after print().
import { printableParts } from '.';

export const PRINT_ID = 'bp-print-report';
/** How long after print() the page's own title comes back when no afterprint does. */
export const TITLE_BACK_MS = 60_000;

/** While the report prints under its file name: the page's own title, and the fallback timer. */
let printing: { was: string; timer?: ReturnType<typeof setTimeout> } | null = null;

function titleBack(): void {
  if (!printing) return;
  clearTimeout(printing.timer);
  document.title = printing.was;
  printing = null;
  window.removeEventListener('afterprint', titleBack);
}

function printTitle(title: string): void {
  titleBack();
  printing = { was: document.title };
  window.addEventListener('afterprint', titleBack);
  document.title = title;
}

export function removePrinted(): void {
  titleBack();
  document.getElementById(PRINT_ID)?.remove();
  document.getElementById(`${PRINT_ID}-style`)?.remove();
}

/** Prints the report; `title`, the file name the dialog suggests for Save as PDF (without .pdf). */
export async function printReport(html: string, title?: string): Promise<void> {
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
  if (title) printTitle(title);
  await Promise.all([...holder.querySelectorAll('img')].map(i => i.decode?.().catch(() => undefined)));
  await new Promise(r => setTimeout(r, 0));     // the new title reaches the shell before the print does
  try {
    await Promise.resolve(window.print());
  } finally {
    if (printing) { clearTimeout(printing.timer); printing.timer = setTimeout(titleBack, TITLE_BACK_MS); }
  }
}
