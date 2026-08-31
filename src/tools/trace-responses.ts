import { launchBrowser, newPage } from '../browser/session.js';
import { settle } from '../browser/execute.js';
import { parseArgs } from '../util/args.js';

// ---------------------------------------------------------------------------
// Logs every response the browser sees while navigating, so we can tell what
// signal a failure actually produces.
//
//   npm run trace -- http://localhost:3000/home --click "Continue to Payment"
// ---------------------------------------------------------------------------

async function main() {
  const { positionals, options } = parseArgs();
  const url = positionals[0] ?? 'http://localhost:3000/home';
  const clickName = options.get('click');

  const browser = await launchBrowser();
  try {
    const page = await newPage(browser);

    page.on('response', (r) => {
      const req = r.request();
      const main = req.frame() === page.mainFrame() ? 'main' : 'sub';
      console.log(
        `  ${String(r.status()).padEnd(4)} ${req.resourceType().padEnd(10)} ${main.padEnd(5)} ${req.method()} ${r.url()}`,
      );
    });
    page.on('requestfailed', (req) =>
      console.log(`  FAIL ${req.resourceType().padEnd(10)}       ${req.url()} — ${req.failure()?.errorText}`),
    );
    page.on('pageerror', (e) => console.log(`  PAGEERROR  ${e.message.split('\n')[0]}`));
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`  CONSOLE.ERR  ${m.text().split('\n')[0]?.slice(0, 160)}`);
    });

    console.log(`\n--- goto ${url} ---`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await settle(page);

    if (clickName) {
      console.log(`\n--- click "${clickName}" ---`);
      await page.getByRole('link', { name: clickName, exact: true }).click();
      await settle(page);
    }

    console.log(`\nfinal url: ${page.url()}`);
    console.log(`title: ${await page.title()}`);
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
