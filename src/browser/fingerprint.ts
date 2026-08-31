import type { Fingerprint } from '../baseline/types.js';
import type { ExtractedElement } from './extract.js';

/**
 * Snapshots what an element looked like at record time.
 *
 * Shared by baseline generation and healing: whenever a step's locator is
 * written, the fingerprint beside it must describe the element that locator now
 * points at. A fingerprint left over from a previous generation would feed the
 * healer evidence about an element that no longer exists.
 */
export function toFingerprint(element: ExtractedElement): Fingerprint {
  return {
    role: element.role,
    tagName: element.tagName,
    accessibleName: element.accessibleName,
    text: element.text,
    ariaLabel: element.ariaLabel,
    id: element.id,
    testId: element.testId,
    nameAttr: element.nameAttr,
    inputType: element.inputType,
    placeholder: element.placeholder,
    context: element.context,
    nearbyText: element.nearbyText,
  };
}
