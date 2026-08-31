import { extractPage, renderElementsForPrompt } from '../browser/extract.js';
import { settle } from '../browser/execute.js';
import { describeLocator, resolveLocators } from '../browser/locator.js';
import { launchBrowser, newPage } from '../browser/session.js';
import { parseArgs } from '../util/args.js';

// ---------------------------------------------------------------------------
// Shows exactly what the LLM will see for a page. No model call, no cost.
//
//   npm run probe -- http://localhost:3000
//   npm run probe -- http://localhost:3000 --headed
//   npm run probe -- http://localhost:3000 --locators   # derived + verified locators
// ---------------------------------------------------------------------------

async function main() {
  const { positionals, flags } = parseArgs();
  const url = positionals[0] ?? 'http://localhost:3000';

  const browser = await launchBrowser({ headed: flags.has('headed') });
  try {
    const page = await newPage(browser);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await settle(page);

    const snapshot = await extractPage(page);
    console.log(renderElementsForPrompt(snapshot));

    // Which locators actually resolve, in the order the recorder would pick them.
    // Worth seeing directly: an element with no verifiable locator cannot be part
    // of a baseline at all, and that is invisible from the element list alone.
    if (flags.has('locators')) {
      console.log('\nVerified locators (primary first):\n');
      for (const element of snapshot.elements) {
        const resolved = await resolveLocators(page, element);
        const label = `${element.role} "${element.accessibleName}"`.slice(0, 40).padEnd(40);
        if (!resolved) {
          console.log(`  ${element.ref.padEnd(6)} ${label} NONE — not uniquely locatable`);
          continue;
        }
        console.log(`  ${element.ref.padEnd(6)} ${label} ${describeLocator(resolved.primary)}`);
        for (const fallback of resolved.fallbacks) {
          console.log(`  ${' '.repeat(6)} ${' '.repeat(40)}   ${describeLocator(fallback)}`);
        }
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
