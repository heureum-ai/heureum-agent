/**
 * Content extraction script injected into pages via chrome.scripting.executeScript.
 * Returns structured page info for the LLM.
 */
(function extractPageContent() {
  const MAX_TEXT_LENGTH = 5000;
  const MAX_ELEMENTS = 200;

  /**
   * Generate a unique CSS selector for an element.
   */
  function getSelector(el) {
    // Try id first
    if (el.id) {
      return `#${CSS.escape(el.id)}`;
    }

    // Try unique attribute selectors
    const uniqueAttrs = ['name', 'data-testid', 'data-product-id', 'data-item-id', 'aria-label', 'href', 'type'];
    for (const attr of uniqueAttrs) {
      const val = el.getAttribute(attr);
      if (val) {
        const sel = `${el.tagName.toLowerCase()}[${attr}=${CSS.escape(val)}]`;
        if (document.querySelectorAll(sel).length === 1) {
          return sel;
        }
      }
    }

    // Build path-based selector
    const parts = [];
    let current = el;
    while (current && current !== document.body) {
      let sel = current.tagName.toLowerCase();
      if (current.id) {
        sel = `#${CSS.escape(current.id)}`;
        parts.unshift(sel);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === current.tagName
        );
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          sel += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(sel);
      current = parent;
    }
    return parts.join(' > ');
  }

  /**
   * Get visible text label for an element.
   */
  function getLabel(el) {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;

    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return `${placeholder} (placeholder)`;

    const title = el.getAttribute('title');
    if (title) return title;

    const text = el.innerText?.trim();
    if (text && text.length <= 80) return text;
    if (text) return text.substring(0, 77) + '...';

    // For images inside links/buttons, use alt text
    const img = el.querySelector('img');
    if (img) {
      const alt = img.getAttribute('alt');
      if (alt) return alt;
    }

    const alt = el.getAttribute('alt');
    if (alt) return alt;

    const value = el.getAttribute('value');
    if (value && el.tagName === 'INPUT' && el.type === 'submit') return value;

    return '';
  }

  /**
   * Get element type description.
   */
  function getType(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    if (role) return role;
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const type = el.type || 'text';
      if (type === 'submit') return 'button';
      return `input:${type}`;
    }
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return 'select';
    return tag;
  }

  /**
   * Check if element is visible.
   */
  function isVisible(el) {
    if (!el.offsetParent && el.style.position !== 'fixed' && el.style.position !== 'sticky') return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * Check if element is inside a nav/header region.
   */
  function isInNavOrHeader(el) {
    let current = el;
    while (current && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      const role = current.getAttribute('role');
      if (tag === 'nav' || tag === 'header' || tag === 'footer' ||
          role === 'navigation' || role === 'banner' || role === 'contentinfo') {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  // Collect interactive elements
  const selectors = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [onclick], [tabindex="0"]';
  const allElements = document.querySelectorAll(selectors);

  const navElements = [];
  const mainElements = [];

  for (const el of allElements) {
    if (!isVisible(el)) continue;

    const label = getLabel(el);
    const type = getType(el);
    const selector = getSelector(el);

    const entry = { type, label, selector };

    if (isInNavOrHeader(el)) {
      navElements.push(entry);
    } else {
      mainElements.push(entry);
    }
  }

  // Prioritize main content elements over nav/header, cap total
  const elements = [];
  const mainCap = Math.min(mainElements.length, MAX_ELEMENTS);
  for (let i = 0; i < mainCap; i++) {
    elements.push(mainElements[i]);
  }
  const navCap = Math.min(navElements.length, MAX_ELEMENTS - elements.length);
  for (let i = 0; i < navCap; i++) {
    elements.push(navElements[i]);
  }

  // Build output
  const lines = [];
  lines.push(`Page: "${document.title}"`);
  lines.push(`URL: ${location.href}`);
  lines.push('');
  lines.push('[Interactive Elements]');

  for (let i = 0; i < elements.length; i++) {
    const { type, label, selector } = elements[i];
    const labelPart = label ? ` "${label}"` : '';
    lines.push(`${i + 1}. [${type}]${labelPart} - ${selector}`);
  }

  lines.push('');
  lines.push('[Visible Text]');
  let bodyText = document.body.innerText || '';
  if (bodyText.length > MAX_TEXT_LENGTH) {
    bodyText = bodyText.substring(0, MAX_TEXT_LENGTH) + '\n...(truncated)';
  }
  lines.push(bodyText);

  return lines.join('\n');
})();
