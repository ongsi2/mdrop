import type { Source } from './files.ts';

export type ReadingAnchor = { id: string; offset: number } | { y: number };
export type Visit = { source: Source; anchor?: ReadingAnchor };
export type DocumentTab = {
  id: number;
  source: Source;
  anchor?: ReadingAnchor;
  visits: Visit[];
  visitIndex: number;
};

/** Open documents live only in this window. File handles identify documents;
    equal names in different folders must remain separate tabs. */
export class DocumentTabs {
  readonly entries: DocumentTab[] = [];
  active: DocumentTab | null = null;
  private serial = 0;

  async find(source: Source): Promise<DocumentTab | undefined> {
    for (const tab of this.entries) {
      if (tab.source === source) return tab;
      if (source.file && tab.source.file) {
        const same = await source.file.isSameEntry(tab.source.file).catch(() => false);
        if (same && this.entries.includes(tab)) return tab;
      } else if (source.recentKey && source.recentKey === tab.source.recentKey) {
        return tab;
      }
    }
    return undefined;
  }

  add(source: Source): DocumentTab {
    const tab: DocumentTab = {
      id: ++this.serial,
      source,
      visits: [{ source }],
      visitIndex: 0,
    };
    this.entries.push(tab);
    return tab;
  }

  select(tab: DocumentTab): void {
    if (this.entries.includes(tab)) this.active = tab;
  }

  neighbor(tab: DocumentTab): DocumentTab | undefined {
    const index = this.entries.indexOf(tab);
    return index < 0 ? undefined : this.entries[index + 1] ?? this.entries[index - 1];
  }

  remove(tab: DocumentTab): void {
    const index = this.entries.indexOf(tab);
    if (index < 0) return;
    if (this.active === tab) this.active = this.neighbor(tab) ?? null;
    this.entries.splice(index, 1);
  }

  clear(): void {
    this.entries.length = 0;
    this.active = null;
  }
}
