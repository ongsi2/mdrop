/* Static page copy lives in each HTML shell so neither language
   flashes on load. Only the strings JavaScript produces at runtime
   are looked up here. */

import { safeSet } from './storage';

export type Lang = 'ko' | 'en';

const STORAGE_KEY = 'mdview:lang';

export const lang: Lang = document.documentElement.lang.startsWith('en') ? 'en' : 'ko';

export function rememberLang(next: Lang): void {
  safeSet(STORAGE_KEY, next);
}

const strings = {
  ko: {
    copy: '복사',
    copied: '복사됨',
    copyFailed: '실패',
    pastedName: '붙여넣은 문서',
    reloaded: '바뀐 내용으로 다시 그렸습니다',
    pasted: '붙여넣은 내용을 그렸습니다',
    notMarkdown: '마크다운 파일이 아닙니다 (.md, .markdown, .mdown, .mkd, .mdwn)',
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
    recentFolderAccess: (name: string) =>
      `${name} — 상대 이미지를 위해 원래 폴더 권한도 다시 요청할 수 있습니다`,
    skipToContent: '본문으로 건너뛰기',
    copiedRich: '복사했습니다 — 로컬 폴더 이미지는 개인정보 보호를 위해 제외됩니다',
    copiedPlain: '이 브라우저는 서식 복사를 지원하지 않아 원본 마크다운만 복사했습니다',
    copyRichFailed: '복사하지 못했습니다',
    complexityExceeded: '문서 구조가 너무 복잡해 안전하게 열 수 없습니다',
    documentOpened: (name: string, stat: string) => `${name} 문서를 열었습니다. ${stat}`,
    emptyTitle: '내용이 없는 문서입니다',
    emptyBody: '마크다운 내용이 비어 있습니다. 다른 파일을 열거나 내용을 붙여넣어 보세요.',
      openAnother: '다른 파일 열기',
      livePaused: '파일이 너무 커져 자동 새로고침을 멈췄습니다',
      more: '더보기',
      moreOpen: '도구 펼치기',
      moreClose: '도구 접기',
    open: '열기',
    close: '닫기',
    anchorLabel: (title: string) => `${title} 섹션 링크`,
    taskDone: '완료된 할 일',
    taskOpen: '완료하지 않은 할 일',
    tableRegion: '가로로 스크롤할 수 있는 표',
    folderDropUnavailable: '이 브라우저에서는 폴더 드롭을 지원하지 않습니다',
  },
  en: {
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: 'Failed',
    pastedName: 'Pasted document',
    reloaded: 'Reloaded — the file changed on disk',
    pasted: 'Rendered the pasted markdown',
    notMarkdown: 'Not a markdown file (.md, .markdown, .mdown, .mkd, .mdwn)',
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
    recentFolderAccess: (name: string) =>
      `${name} — reopening may also request access to its original folder for relative images`,
    skipToContent: 'Skip to content',
    copiedRich: 'Copied — local folder images were excluded for privacy',
    copiedPlain: 'This browser cannot copy formatting, so the markdown source was copied instead',
    copyRichFailed: 'Could not copy',
    complexityExceeded: 'This document is too structurally complex to open safely',
    documentOpened: (name: string, stat: string) => `Opened ${name}. ${stat}`,
    emptyTitle: 'This document is empty',
    emptyBody: 'There is no markdown content to render. Open another file or paste some text.',
      openAnother: 'Open another file',
      livePaused: 'Live reload paused because the file became too large',
      more: 'More',
      moreOpen: 'Show tools',
      moreClose: 'Hide tools',
    open: 'Open',
    close: 'Close',
    anchorLabel: (title: string) => `Link to the ${title} section`,
    taskDone: 'Completed task',
    taskOpen: 'Incomplete task',
    tableRegion: 'Horizontally scrollable table',
    folderDropUnavailable: 'Folder drop is not supported in this browser',
  },
} as const;

export const t = strings[lang];
