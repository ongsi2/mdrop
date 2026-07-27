/* Copy the rendered document so it survives a paste into 한글, Word,
   Google Docs or an email client.

   Two flavours go on the clipboard at once: `text/html` for word
   processors, and `text/plain` carrying the *original markdown* so a
   paste into a code editor gives back source rather than flattened
   prose. The receiving app picks whichever it understands.

   Presentation is carried by old HTML attributes (`border`, `align`,
   `cellpadding`) rather than inline CSS, for two reasons. This site's
   own `style-src` has no `unsafe-inline`, so every attempt to write a
   style — through `cssText` *or* a single CSSOM property — is blocked
   by our own policy. And word processors honour those attributes more
   reliably than they honour CSS anyway. Everything else is left to
   semantic tags: Word already maps h1–h6, strong, blockquote and pre
   onto its own styles, which is what someone pasting into a report
   actually wants. */

const MAX_INLINE_IMAGE_BYTES = 3 * 1024 * 1024;

const BODY_STYLE =
  "font-family:'Malgun Gothic',Meiryo,sans-serif;font-size:11pt;line-height:1.7;color:#111";

function stripChrome(root: HTMLElement): void {
  root.querySelectorAll('.copy-btn, .anchor').forEach((el) => el.remove());
  root.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
}

/** A disabled checkbox pastes as an empty box or vanishes entirely;
    a literal symbol always survives. */
function flattenTaskLists(root: HTMLElement): void {
  root.querySelectorAll('.task-item').forEach((li) => {
    const box = li.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const done = box?.checked ?? false;
    box?.remove();
    li.insertBefore(document.createTextNode(done ? '☑ ' : '☐ '), li.firstChild);
  });
}

/** The frontmatter card is a CSS grid; without the stylesheet its keys
    and values would stack into an unreadable column. */
function flattenFrontmatter(root: HTMLElement): void {
  const card = root.querySelector('.fm');
  if (!card) return;

  const wrap = document.createElement('blockquote');
  for (const row of Array.from(card.querySelectorAll('.fm__row'))) {
    const line = document.createElement('p');
    const key = document.createElement('b');
    key.textContent = `${row.querySelector('.fm__k')?.textContent ?? ''}: `;
    line.append(key, row.querySelector('.fm__v')?.textContent ?? '');
    wrap.appendChild(line);
  }
  card.replaceWith(wrap);
}

/** Tables are the one thing that genuinely needs help — a bare
    `<table>` pastes into Word with no rules at all. */
function tablesForWordProcessors(root: HTMLElement): void {
  root.querySelectorAll('table').forEach((table) => {
    table.setAttribute('border', '1');
    table.setAttribute('cellpadding', '6');
    table.setAttribute('cellspacing', '0');
    table.setAttribute('width', '100%');
  });

  for (const dir of ['left', 'center', 'right'] as const) {
    root.querySelectorAll(`.ta-${dir}`).forEach((cell) => cell.setAttribute('align', dir));
  }
}

/** Every remaining class refers to a stylesheet the destination will
    never load. */
function stripClasses(root: HTMLElement): void {
  root.querySelectorAll('[class]').forEach((el) => el.removeAttribute('class'));
}

/** Relative images live behind `blob:` URLs that mean nothing outside
    this tab, so they have to travel as data URIs or not at all. */
async function inlineImages(root: HTMLElement): Promise<void> {
  let budget = MAX_INLINE_IMAGE_BYTES;

  await Promise.all(
    Array.from(root.querySelectorAll('img')).map(async (img) => {
      const src = img.getAttribute('src') ?? '';
      if (!src.startsWith('blob:')) return;
      try {
        const blob = await (await fetch(src)).blob();
        if (blob.size > budget) {
          img.remove();
          return;
        }
        budget -= blob.size;
        img.src = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
      } catch {
        img.remove();
      }
    }),
  );
}

async function buildRichHtml(source: HTMLElement): Promise<string> {
  const clone = source.cloneNode(true) as HTMLElement;
  stripChrome(clone);
  flattenFrontmatter(clone);
  flattenTaskLists(clone);
  tablesForWordProcessors(clone);
  stripClasses(clone);
  await inlineImages(clone);

  /* The wrapper's style is assembled as text and never applied to a
     live node, so CSP never sees it. */
  return `<meta charset="utf-8"><div style="${BODY_STYLE}">${clone.innerHTML}</div>`;
}

export type CopyResult = 'rich' | 'plain' | 'failed';

/** Returns which flavour actually made it onto the clipboard —
    `plain` means the browser refused the rich payload and only the
    markdown source went across. */
export async function copyFormatted(doc: HTMLElement, markdownSource: string): Promise<CopyResult> {
  const plain = new Blob([markdownSource], { type: 'text/plain' });

  try {
    const html = await buildRichHtml(doc);
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': plain,
      }),
    ]);
    return 'rich';
  } catch {
    /* Firefox and Safari have historically refused `text/html` on the
       clipboard. Losing the formatting beats losing the copy. */
    try {
      await navigator.clipboard.writeText(markdownSource);
      return 'plain';
    } catch {
      return 'failed';
    }
  }
}
