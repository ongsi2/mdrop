export type TocController = { destroy(): void; count: number };

const MAX_TOC_HEADINGS = 500;

/** Builds the contents rail and keeps the active row in sync with
    the heading currently nearest the top of the viewport. */
export function buildToc(doc: HTMLElement, list: HTMLElement): TocController {
  const allHeadings = Array.from(
    doc.querySelectorAll<HTMLHeadingElement>('h2[id], h3[id], h4[id]'),
  );
  const headings = allHeadings.slice(0, MAX_TOC_HEADINGS);

  list.replaceChildren();
  if (allHeadings.length < 2) return { destroy() {}, count: allHeadings.length };

  const links = new Map<string, HTMLAnchorElement>();
  const scrollBehavior = (): ScrollBehavior =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

  for (const h of headings) {
    const a = document.createElement('a');
    a.className = 'toc__item';
    a.href = `#${h.id}`;
    a.dataset.lv = h.tagName.slice(1);
    /* The permalink `#` lives inside the heading — keep it out of
       the contents text. */
    a.textContent = (h.textContent ?? '').replace(/^#/, '').trim();
    a.addEventListener('click', (e) => {
      e.preventDefault();
      h.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
      /* Preserve the state object — wiping it would erase the
         document marker the Back button relies on. */
      history.replaceState(history.state, '', `#${h.id}`);
      if (!h.hasAttribute('tabindex')) {
        h.tabIndex = -1;
        h.addEventListener('blur', () => h.removeAttribute('tabindex'), { once: true });
      }
      h.focus({ preventScroll: true });
      setActive(h.id);
    });
    list.appendChild(a);
    links.set(h.id, a);
  }

  if (allHeadings.length > headings.length) {
    const note = document.createElement('p');
    note.className = 'toc__limit';
    note.textContent = document.documentElement.lang.startsWith('ko')
      ? `목차는 처음 ${MAX_TOC_HEADINGS.toLocaleString('ko-KR')}개 제목만 표시합니다.`
      : `Contents shows the first ${MAX_TOC_HEADINGS.toLocaleString('en-US')} headings.`;
    list.appendChild(note);
  }

  let active: HTMLAnchorElement | null = null;
  const setActive = (id: string) => {
    const next = links.get(id);
    if (!next || next === active) return;
    active?.classList.remove('is-active');
    active?.removeAttribute('aria-current');
    next.classList.add('is-active');
    next.setAttribute('aria-current', 'location');
    active = next;
    const box = list.parentElement;
    if (box && box.scrollHeight > box.clientHeight) {
      const top = next.offsetTop - box.clientHeight / 2;
      box.scrollTo({ top, behavior: scrollBehavior() });
    }
  };

  const visible = new Set<string>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).id;
        if (entry.isIntersecting) visible.add(id);
        else visible.delete(id);
      }
      const first = headings.find((h) => visible.has(h.id));
      if (first) {
        setActive(first.id);
        return;
      }
      /* Between headings: fall back to the last one scrolled past. */
      /* Heading positions are monotonic, so binary search avoids thousands of
         forced layout reads on unusually large documents. */
      let low = 0;
      let high = headings.length - 1;
      let passed: HTMLHeadingElement | null = null;
      while (low <= high) {
        const middle = (low + high) >>> 1;
        const candidate = headings[middle];
        if (candidate.getBoundingClientRect().top < 120) {
          passed = candidate;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (passed) setActive(passed.id);
    },
    { rootMargin: '-72px 0px -70% 0px', threshold: 0 },
  );

  headings.forEach((h) => observer.observe(h));

  return {
    destroy() {
      observer.disconnect();
      list.replaceChildren();
    },
    count: allHeadings.length,
  };
}
