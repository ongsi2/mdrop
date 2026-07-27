export type TocController = { destroy(): void; count: number };

/** Builds the contents rail and keeps the active row in sync with
    the heading currently nearest the top of the viewport. */
export function buildToc(doc: HTMLElement, list: HTMLElement): TocController {
  const headings = Array.from(
    doc.querySelectorAll<HTMLHeadingElement>('h2[id], h3[id], h4[id]'),
  );

  list.replaceChildren();
  if (headings.length < 2) return { destroy() {}, count: headings.length };

  const links = new Map<string, HTMLAnchorElement>();

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
      h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      /* Preserve the state object — wiping it would erase the
         document marker the Back button relies on. */
      history.replaceState(history.state, '', `#${h.id}`);
    });
    list.appendChild(a);
    links.set(h.id, a);
  }

  let active: HTMLAnchorElement | null = null;
  const setActive = (id: string) => {
    const next = links.get(id);
    if (!next || next === active) return;
    active?.classList.remove('is-active');
    next.classList.add('is-active');
    active = next;
    const box = list.parentElement;
    if (box && box.scrollHeight > box.clientHeight) {
      const top = next.offsetTop - box.clientHeight / 2;
      box.scrollTo({ top, behavior: 'smooth' });
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
      const passed = headings.filter((h) => h.getBoundingClientRect().top < 120).pop();
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
    count: headings.length,
  };
}
