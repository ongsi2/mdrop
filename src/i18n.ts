/* Static page copy lives in each HTML shell so neither language
   flashes on load. Only the strings JavaScript produces at runtime
   are looked up here. */

export type Lang = 'ko' | 'en';

const STORAGE_KEY = 'mdview:lang';

export const lang: Lang = document.documentElement.lang.startsWith('en') ? 'en' : 'ko';

export function rememberLang(next: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* private mode — the switch still works for this visit */
  }
}

const strings = {
  ko: {
    copy: '복사',
    copied: '복사됨',
    copyFailed: '실패',
    pastedName: '붙여넣은 문서',
    reloaded: '바뀐 내용으로 다시 그렸습니다',
    pasted: '붙여넣은 내용을 그렸습니다',
    notMarkdown: '마크다운 파일이 아닙니다 (.md, .markdown, .mdown, .mkd)',
    openFailed: '파일을 열지 못했습니다',
    readFailed: '파일을 읽지 못했습니다',
    installed: '설치했습니다. 이제 .md 를 더블클릭해 보세요',
    tooLarge: (mb: number) => `파일이 너무 큽니다 (최대 ${mb}MB)`,
    stat: (chars: number, minutes: number) =>
      `${chars.toLocaleString('ko-KR')}자 · 약 ${minutes}분`,
    updateReady: '새 버전이 준비됐습니다',
    reload: '새로고침',
    recentTitle: '최근 문서',
    recentClear: '목록 지우기',
    recentGone: '파일을 찾을 수 없습니다. 목록에서 뺐습니다',
    recentDenied: '권한이 없어 열 수 없습니다',
    skipToContent: '본문으로 건너뛰기',
    copiedRich: '복사했습니다 — 한글·워드에 그대로 붙여넣으세요',
    copiedPlain: '이 브라우저는 서식 복사를 지원하지 않아 원본 마크다운만 복사했습니다',
    copyRichFailed: '복사하지 못했습니다',
  },
  en: {
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: 'Failed',
    pastedName: 'Pasted document',
    reloaded: 'Reloaded — the file changed on disk',
    pasted: 'Rendered the pasted markdown',
    notMarkdown: 'Not a markdown file (.md, .markdown, .mdown, .mkd)',
    openFailed: 'Could not open that file',
    readFailed: 'Could not read that file',
    installed: 'Installed. Try double-clicking a .md file now',
    tooLarge: (mb: number) => `That file is too large (max ${mb}MB)`,
    stat: (chars: number, minutes: number) =>
      `${chars.toLocaleString('en-US')} chars · ~${minutes} min`,
    updateReady: 'A new version is ready',
    reload: 'Reload',
    recentTitle: 'Recent',
    recentClear: 'Clear list',
    recentGone: 'That file is gone — removed from the list',
    recentDenied: 'Permission denied, cannot open',
    skipToContent: 'Skip to content',
    copiedRich: 'Copied — paste straight into Word or Docs',
    copiedPlain: 'This browser cannot copy formatting, so the markdown source was copied instead',
    copyRichFailed: 'Could not copy',
  },
} as const;

export const t = strings[lang];
