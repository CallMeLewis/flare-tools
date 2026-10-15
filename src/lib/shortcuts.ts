/** Whether a dialog is open over the app, in which case the app's own keyboard shortcuts stand down. */
export function dialogOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}
