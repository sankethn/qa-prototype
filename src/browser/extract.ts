import type { Page } from 'playwright';

/** One candidate element as the LLM sees it. */
export interface ExtractedElement {
  /** Session-local handle, mirrored onto the DOM as `data-qa-ref`. */
  ref: string;
  tagName: string;
  role: string;
  accessibleName: string;
  text: string;
  ariaLabel: string | null;
  id: string | null;
  testId: string | null;
  nameAttr: string | null;
  inputType: string | null;
  placeholder: string | null;
  labelText: string | null;
  altText: string | null;
  context: string | null;
  nearbyText: string[];
  interactive: boolean;
  enabled: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: ExtractedElement[];
  /** True when extraction hit the cap and dropped low-priority elements. */
  truncated: boolean;
}

export const REF_ATTRIBUTE = 'data-qa-ref';

/**
 * Refs are namespaced per extraction pass. Without this, an element left over
 * from an earlier pass could still carry `data-qa-ref="e5"` while a different
 * element becomes `e5` in the current pass — and locator verification would
 * confirm the wrong element.
 */
let extractionPass = 0;

/**
 * Walks the DOM and returns everything a step might plausibly target.
 *
 * Deliberately not limited to interactive elements: `assert` steps target static
 * content ("the product is visible"), so headings, images and test-id-bearing
 * containers are collected too and flagged with `interactive: false`.
 *
 * Each element is stamped with `data-qa-ref` so the resolver can act on exactly
 * the element the model chose. That attribute is scaffolding for this run only —
 * the durable locator is always derived from the page's own attributes.
 */
export async function extractPage(page: Page, maxElements = 120): Promise<PageSnapshot> {
  const pass = extractionPass++;
  return page.evaluate(
    ({ refAttribute, cap, pass }) => {
      const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];

      const INTERACTIVE_SELECTOR = [
        'a[href]',
        'button',
        'input:not([type="hidden"])',
        'select',
        'textarea',
        'summary',
        '[role="button"]',
        '[role="link"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[role="option"]',
        '[role="switch"]',
        '[contenteditable="true"]',
        '[onclick]',
        '[tabindex]:not([tabindex="-1"])',
      ].join(',');

      const CONTENT_SELECTOR = [
        'h1',
        'h2',
        'h3',
        'h4',
        'img[alt]',
        '[role="heading"]',
        '[role="alert"]',
        '[role="status"]',
        ...TEST_ID_ATTRS.map((a) => `[${a}]`),
      ].join(',');

      const clean = (value: string | null | undefined, max = 200): string =>
        (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

      const isVisible = (el: Element): boolean => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (Number(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        // Zero-size is fine for inputs that are visually replaced (custom checkboxes).
        return rect.width > 0 || rect.height > 0 || el.tagName === 'INPUT';
      };

      const implicitRole = (el: Element): string => {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit;

        const tag = el.tagName.toLowerCase();
        if (tag === 'input') {
          const type = (el.getAttribute('type') ?? 'text').toLowerCase();
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          if (type === 'number') return 'spinbutton';
          if (type === 'range') return 'slider';
          if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
          if (type === 'search') return 'searchbox';
          return 'textbox';
        }
        if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
        if (tag === 'button' || tag === 'summary') return 'button';
        if (tag === 'select') return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'img') return 'img';
        if (/^h[1-6]$/.test(tag)) return 'heading';
        if (tag === 'li') return 'listitem';
        if (tag === 'form') return 'form';
        if (tag === 'nav') return 'navigation';
        if (tag === 'table') return 'table';
        return 'generic';
      };

      const labelFor = (el: Element): string | null => {
        const id = el.getAttribute('id');
        if (id) {
          const escaped = window.CSS?.escape ? window.CSS.escape(id) : id;
          const label = document.querySelector(`label[for="${escaped}"]`);
          if (label) return clean(label.textContent, 120);
        }
        const wrapping = el.closest('label');
        if (wrapping) return clean(wrapping.textContent, 120);
        return null;
      };

      /** Simplified accessible-name computation, in spec precedence order. */
      const accessibleName = (el: Element): string => {
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const parts = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .filter(Boolean);
          if (parts.length > 0) return clean(parts.join(' '), 120);
        }

        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) return clean(ariaLabel, 120);

        const label = labelFor(el);
        if (label) return label;

        const alt = el.getAttribute('alt');
        if (alt) return clean(alt, 120);

        const tag = el.tagName.toLowerCase();
        if (tag === 'input') {
          const type = (el.getAttribute('type') ?? 'text').toLowerCase();
          // Only value-as-name for button-like inputs; a text input's value is data.
          if (['button', 'submit', 'reset'].includes(type)) {
            return clean((el as HTMLInputElement).value, 120);
          }
          return clean(el.getAttribute('placeholder'), 120);
        }

        const title = el.getAttribute('title');
        const own = clean(el.textContent, 120);
        return own || clean(title, 120);
      };

      /** Nearest meaningful container, used to disambiguate repeated elements. */
      const contextOf = (el: Element): string | null => {
        let node: Element | null = el.parentElement;
        while (node && node !== document.body) {
          const labelled = node.getAttribute('aria-label') ?? node.getAttribute('data-testid');
          if (labelled) return clean(labelled, 80);

          const tag = node.tagName.toLowerCase();
          if (['form', 'nav', 'header', 'footer', 'main', 'aside', 'dialog'].includes(tag)) {
            const heading = node.querySelector('h1,h2,h3,h4,legend');
            return clean(heading?.textContent, 80) || tag;
          }
          if (['section', 'article'].includes(tag)) {
            const heading = node.querySelector('h1,h2,h3,h4');
            const name = clean(heading?.textContent, 80);
            if (name) return name;
          }
          node = node.parentElement;
        }
        return null;
      };

      /** Sibling text that helps a human tell two identical buttons apart. */
      const nearbyTextOf = (el: Element): string[] => {
        const parent = el.parentElement;
        if (!parent) return [];
        const own = clean(el.textContent, 200);
        const out: string[] = [];
        for (const child of Array.from(parent.children)) {
          if (child === el || out.length >= 5) continue;
          const text = clean(child.textContent, 60);
          if (text && text !== own && !out.includes(text)) out.push(text);
        }
        return out;
      };

      const interactive = new Set(Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)));
      const content = Array.from(document.querySelectorAll(CONTENT_SELECTOR));
      const all = [...interactive, ...content.filter((el) => !interactive.has(el))];

      const collected: Array<
        Record<string, unknown> & { interactive: boolean }
      > = [];
      let index = 0;

      for (const el of all) {
        if (!isVisible(el)) continue;

        const ref = `s${pass}e${index++}`;
        el.setAttribute(refAttribute, ref);

        let testId: string | null = null;
        for (const attr of TEST_ID_ATTRS) {
          const found = el.getAttribute(attr);
          if (found) {
            testId = found;
            break;
          }
        }

        const inputType = el.getAttribute('type');
        collected.push({
          ref,
          tagName: el.tagName.toLowerCase(),
          role: implicitRole(el),
          accessibleName: accessibleName(el),
          text: clean(el.textContent, 150),
          ariaLabel: el.getAttribute('aria-label'),
          id: el.getAttribute('id'),
          testId,
          nameAttr: el.getAttribute('name'),
          inputType: inputType ? inputType.toLowerCase() : null,
          placeholder: el.getAttribute('placeholder'),
          labelText: labelFor(el),
          altText: el.getAttribute('alt'),
          context: contextOf(el),
          nearbyText: nearbyTextOf(el),
          interactive: interactive.has(el),
          enabled: !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true',
        });
      }

      // Interactive elements are the likelier targets, so they survive the cap.
      const ranked = [
        ...collected.filter((e) => e.interactive),
        ...collected.filter((e) => !e.interactive),
      ];

      return {
        url: window.location.href,
        title: document.title,
        elements: ranked.slice(0, cap),
        truncated: ranked.length > cap,
      };
    },
    { refAttribute: REF_ATTRIBUTE, cap: maxElements, pass },
  ) as unknown as Promise<PageSnapshot>;
}

/** Compact rendering for the prompt — JSON of this would be mostly null padding. */
export function renderElementsForPrompt(snapshot: PageSnapshot): string {
  const lines = snapshot.elements.map((el) => {
    const parts = [`[${el.ref}]`, el.role];
    if (el.accessibleName) parts.push(`name="${el.accessibleName}"`);
    if (el.testId) parts.push(`testid="${el.testId}"`);
    if (el.inputType) parts.push(`type=${el.inputType}`);
    if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
    if (el.labelText && el.labelText !== el.accessibleName) parts.push(`label="${el.labelText}"`);
    if (el.id) parts.push(`id="${el.id}"`);
    if (el.context) parts.push(`in="${el.context}"`);
    if (!el.enabled) parts.push('DISABLED');
    if (!el.interactive) parts.push('static');
    if (el.nearbyText.length > 0) parts.push(`near=[${el.nearbyText.join(' | ')}]`);
    return parts.join(' ');
  });

  return [
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title}`,
    '',
    ...lines,
    snapshot.truncated ? '\n(element list was truncated)' : '',
  ]
    .join('\n')
    .trim();
}
