import type {ReceiptV1} from '../contracts/index.js';
import {ReceiptSchema} from '../contracts/index.js';
import {receiptDigest} from '../core/receipts/receipt-store.js';

export function renderReceiptHtml(receiptInput: ReceiptV1): string {
  const receipt = ReceiptSchema.parse(receiptInput);
  const digest = receiptDigest(receipt);
  const json = escapeHtml(JSON.stringify(receipt, undefined, 2));
  const subject = escapeHtml(receipt.candidate.commit.subject);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
  <title>Antibody proof — ${subject}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    body { max-width: 76rem; margin: 0 auto; padding: 2rem; line-height: 1.5; }
    header, section { border: 1px solid #7778; border-radius: .75rem; padding: 1rem; margin-bottom: 1rem; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: .4rem 1rem; }
    dt { font-weight: 700; } dd { margin: 0; overflow-wrap: anywhere; }
    pre { overflow: auto; padding: 1rem; background: #7771; border-radius: .5rem; }
    .verified { font-weight: 800; text-transform: uppercase; }
  </style>
</head>
<body>
  <header>
    <h1>Antibody causal proof</h1>
    <p class="verified">${escapeHtml(receipt.verdict)}</p>
    <p>${subject}</p>
  </header>
  <section>
    <h2>Identity</h2>
    <dl>
      <dt>Repository</dt><dd>${escapeHtml(receipt.candidate.repository.slug)}</dd>
      <dt>Parent</dt><dd>${escapeHtml(receipt.candidate.parentSha)}</dd>
      <dt>Fix</dt><dd>${escapeHtml(receipt.candidate.fixSha)}</dd>
      <dt>Head</dt><dd>${escapeHtml(receipt.candidate.headSha)}</dd>
      <dt>Patch</dt><dd>${escapeHtml(receipt.patch.sha256)}</dd>
      <dt>Receipt</dt><dd>${escapeHtml(digest)}</dd>
    </dl>
  </section>
  <section>
    <h2>Canonical receipt</h2>
    <pre>${json}</pre>
  </section>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
