/**
 * A single branded HTML shell every "designed" outbound email is wrapped
 * in (exam pins, NECO confirmations, and anywhere else that wants more than
 * a wall of plain text) — table-based layout with every style inlined, no
 * `<style>` block and no CSS classes, because that's what actually survives
 * Gmail/Outlook/Apple Mail's HTML sanitizing (they strip `<style>` tags and
 * rewrite/ignore classes in inconsistent ways across clients). Keep this the
 * one place the PAYDER email "look" lives so new emails automatically match
 * instead of every call site reinventing its own layout.
 *
 * Colors match the web app's own brand tokens (see
 * `web/app/globals.css` — --color-brand-navy / --color-brand-orange) so an
 * email and the web app read as the same product.
 */
export function renderEmailHtml(params: { heading: string; bodyHtml: string }): string {
  const { heading, bodyHtml } = params;
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
            <tr>
              <td style="background-color:#16213a;padding:28px 32px;">
                <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:0.5px;">PAYDER</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 16px;font-size:18px;line-height:1.4;color:#16213a;font-weight:700;">${heading}</h1>
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;background-color:#f9fafb;border-top:1px solid #eef0f3;">
                <p style="margin:0;font-size:12px;color:#8a8f98;line-height:1.5;">
                  This is an automated message from PAYDER. If you weren't expecting this, you can
                  safely ignore it or contact support from the app.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Escapes text that came from a human (an admin's freeform note/reason, a
 * name) before it's interpolated into HTML — not a security boundary (call
 * sites are staff/PAYDER-controlled, not public input), just cheap
 * insurance against a stray "<" or "&" visually breaking the email. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** A plain `<p>` styled to match the template's body copy — for ordinary paragraphs. */
export function paragraphHtml(text: string): string {
  return `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#3c4257;">${text}</p>`;
}

/** The highlighted "pin" box — the visual centerpiece of an exam-pin email. */
export function pinBoxHtml(pin: string): string {
  return `<div style="margin:20px 0;padding:20px;background-color:#fff3e9;border:1px dashed #ff7a1a;border-radius:12px;text-align:center;">
    <p style="margin:0 0 6px;font-size:11px;letter-spacing:1px;color:#e2650a;text-transform:uppercase;font-weight:600;">Your pin</p>
    <p style="margin:0;font-size:28px;letter-spacing:4px;color:#16213a;font-weight:700;font-family:'Courier New',monospace;">${pin}</p>
  </div>`;
}

/** A muted callout box — used for an admin's freeform confirmation note. */
export function noteBoxHtml(note: string): string {
  return `<div style="margin:0 0 14px;padding:14px 16px;background-color:#f4f5f7;border-left:3px solid #16213a;border-radius:8px;">
    <p style="margin:0;font-size:13px;line-height:1.6;color:#3c4257;white-space:pre-wrap;">${escapeHtml(note)}</p>
  </div>`;
}
