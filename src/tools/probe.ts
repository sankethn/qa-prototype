import { extractPage, renderElementsForPrompt } from '../browser/extract.js';
import { settle } from '../browser/execute.js';
import { launchBrowser, newPage } from '../browser/session.js';
import { parseArgs } from '../util/args.js';

// ---------------------------------------------------------------------------
// Shows exactly what the LLM will see for a page. No model call, no cost.
//
//   npm run probe -- http://localhost:3000
//   npm run probe -- http://localhost:3000 --headed
// ---------------------------------------------------------------------------

async function main() {
  const { positionals, flags } = parseArgs();
  const url = positionals[0] ?? 'http://localhost:3000';

  const browser = await launchBrowser({ headed: flags.has('headed') });
  try {
    const page = await newPage(browser);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await settle(page);
    console.log(renderElementsForPrompt(await extractPage(page)));
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
