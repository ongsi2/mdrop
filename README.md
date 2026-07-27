# MDVIEW

마크다운 파일을 끌어다 놓으면 바로 읽히는 뷰어. 설치도, 로그인도, 라이선스도 없습니다.

**파일은 서버로 전송되지 않습니다.** 업로드 경로 자체가 존재하지 않고, 파싱과 렌더링이 전부
브라우저 안에서 끝납니다. 백엔드가 없습니다.

- 한국어 — `/`
- English — `/en/`

---

## 여는 방법 네 가지

| 방법 | 동작 | 지원 |
| --- | --- | --- |
| 드래그 앤 드롭 | 창 아무 데나 `.md` 를 놓기 | 전부 |
| 파일 열기 | `Ctrl` + `O` | 전부 |
| 붙여넣기 | `Ctrl` + `V` 로 마크다운 텍스트 | 전부 |
| **탐색기에서 더블클릭** | `.md` 더블클릭 → 바로 렌더 | Chrome · Edge (설치 후) |

받는 확장자는 **`.md` `.markdown` `.mdown` `.mkd` `.mdwn` 뿐입니다.** `.txt` 는 마크다운이
아니라서, `.mdx` 는 JSX 라서 거부합니다. 파일 크기 상한은 **4MB** 입니다 — 그 이상은 렌더링에
수 초가 걸려 탭이 멈추고, 정상적인 문서는 근처에도 가지 않는 크기입니다.

폴더를 통째로 놓으면 그 안의 `README` 를 먼저 열고, `![](./img/a.png)` 같은 **상대경로
이미지까지 표시**합니다. 파일 하나만 놓으면 브라우저 보안 정책상 형제 파일에 접근할 수 없어
이미지는 자리표시자로 남습니다.

## 앱 설치 — 내려받을 설치 파일은 없습니다

PWA 라서 `.exe` 나 설치 마법사가 존재하지 않습니다. 브라우저가 직접 등록하고, 스토어에 올리거나
따로 심사받을 필요도 없습니다. **HTTPS 로 서비스되는 매니페스트 + 서비스워커, 그게 설치 조건의
전부입니다.**

1. Chrome 또는 Edge 로 사이트를 엽니다.
2. 상단의 **앱으로 설치** 버튼 (또는 주소창 오른쪽 설치 아이콘).
3. 탐색기에서 아무 `.md` 파일 우클릭 → **연결 프로그램** → **다른 앱 선택** → `MDVIEW` →
   *항상 이 앱을 사용* 체크.
4. 첫 실행 때 Chrome 이 "MDVIEW 에서 .md 파일을 열도록 허용할까요?" 를 한 번 묻습니다.

제거는 앱 목록에서 지우면 끝입니다. 레지스트리에 남는 것도, 언인스톨러도 없습니다.

> Microsoft Store 등록도 가능은 합니다 (PWABuilder 로 패키징). 다만 배포 이점이 거의 없고
> 심사 비용만 생기므로 권하지 않습니다.

## 기능

- GFM 표 · 정렬, 체크리스트, 각주, `<details>`, 프론트매터 카드
- 코드 하이라이트 — 언어가 명시된 펜스에만, **문서에 코드가 있을 때만 내려받음**
- 목차 사이드바 + 스크롤 위치 추적 (`T`)
- 다크 / 라이트 (`D`), 인쇄·PDF 전용 스타일 (`Ctrl` + `P`)
- **라이브 리로드** — 파일 핸들로 연 문서는 편집기에서 저장하는 순간 다시 그려집니다.
  읽던 위치는 **가장 가까운 제목에 고정**되므로, 위쪽에 내용이 추가돼도 화면이 밀리지 않습니다
- **최근 문서** — 열었던 파일을 한 번 클릭으로 다시 엽니다 (`src/recent.ts`).
  IndexedDB 에 **핸들만** 저장하고 내용은 저장하지 않으며, 권한이 만료됐으면 브라우저가 다시 묻습니다
- 새 버전 배포 시 "새로고침" 토스트 — 읽던 문서를 임의로 날리지 않습니다
- 오프라인 동작 (서비스 워커)
- 한국어 조판: `word-break: keep-all` 로 단어 중간 줄바꿈 없음

## 접근성

- 본문 바로가기 링크 (`Tab` 첫 번째)
- 텍스트 대비는 **WCAG AA (4.5:1) 이상**. 팔레트의 가장 흐린 두 단계
  (`--tx-faint`, `--tx-off`)는 테두리·장식 전용이며 글자에는 쓰지 않습니다
- `prefers-reduced-motion` 존중, 모든 조작에 키보드 접근 가능

## 단축키

| 키 | 동작 |
| --- | --- |
| `Ctrl` + `O` | 파일 열기 |
| `Ctrl` + `V` | 마크다운 붙여넣기 |
| `T` | 목차 토글 |
| `D` | 테마 전환 |
| `Ctrl` + `P` | 인쇄 / PDF |

## 보안

마크다운은 원시 HTML 을 허용하기 때문에, 신뢰할 수 없는 `.md` 파일은 그 자체가 공격 표면입니다.
막아둔 것:

- **CSP** — 프로덕션 빌드에만 주입됩니다 (`vite.config.ts`). `script-src 'self'` 가 핵심입니다.
  설령 무언가 소독기를 통과하더라도 실행할 출처가 없습니다. `frame-ancestors` 는 메타 태그에서
  무시되므로 `vercel.json` 헤더로 나갑니다.
- **DOMPurify** — 렌더 결과는 소독한 뒤에만 DOM 에 들어갑니다. `<script>` `<iframe>` `<form>`
  `<input>` `<button>` `<svg>` `<math>` `<style>` 및 미디어 태그는 제거됩니다. SVG·MathML 은
  뷰어에 쓸 일이 없는 데다 파서 차이를 이용한 우회 표면이라 아예 거부합니다.
- **`style` 속성 전면 차단** — markdown-it 이 표 정렬을 인라인 스타일로 내보내는 것이 유일한
  예외 사유였으므로, 소독 **전에** 렌더러에서 `class="ta-right"` 같은 클래스로 바꿔치기합니다
  (`render.ts`). 덕분에 속성을 통째로 금지할 수 있습니다.
- **링크** — `javascript:` 계열은 DOMPurify 가 제거하고, 외부 링크에는 `target="_blank"` 와
  `rel="noopener noreferrer"` 가 붙습니다.
- **확장자·크기 제한** — 위 참조.
- **응답 헤더** (`vercel.json`) — HSTS, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy`, COOP.

## SEO

- `/` 와 `/en/` 각각 canonical + `hreflang` 상호 링크 + `x-default`
- Open Graph · Twitter 카드 + `og.png` (1200×630)
- `WebApplication` JSON-LD
- `robots.txt`, `sitemap.xml` (hreflang 포함)
- 크롤러가 읽을 실제 본문 — 빈 랜딩 페이지가 아니라 무엇을 하는 도구인지 설명하는 문단이 있습니다
- 언어별 OG 이미지 (`og.png` / `og-en.png`)
- 양쪽 언어를 담은 `404.html`
- `WebApplication` + `FAQPage` 구조화 데이터, 검색 질의를 그대로 반영한 FAQ 6문항

### IndexNow

Bing · **네이버** · Yandex 는 IndexNow 로 즉시 통보할 수 있습니다 (구글은 미지원).
키 파일이 `public/` 에 있고, 파일명이 곧 키입니다:

```
public/72b62dbc80654391bc7d407b1a4cb799596a60d17dfb4a3ca20b008f2f3bbc3e.txt
```

내용을 크게 바꾼 뒤 다시 알리려면:

```powershell
$key = (Get-ChildItem C:\mdview\public\*.txt | Where-Object Name -match '^[0-9a-f]{64}\.txt$').BaseName
$body = @{ host='mdrop.app'; key=$key; keyLocation="https://mdrop.app/$key.txt";
           urlList=@('https://mdrop.app/','https://mdrop.app/en/') } | ConvertTo-Json -Compress
Invoke-WebRequest -Uri 'https://api.indexnow.org/indexnow' -Method POST -Body $body `
  -ContentType 'application/json; charset=utf-8' -UseBasicParsing
```

키 파일을 지우거나 이름을 바꾸면 제출이 거부됩니다.

### 검색엔진 등록 (소유확인 필요)

구글과 네이버는 소유확인을 거쳐야 색인이 시작됩니다. 발급받은 값을 각 HTML 의 `<head>` 에
넣으면 됩니다.

| | 주소 | 확인 방식 |
| --- | --- | --- |
| Google Search Console | search.google.com/search-console | 도메인 속성 → DNS TXT (`vercel dns add`) 또는 메타태그 |
| 네이버 서치어드바이저 | searchadvisor.naver.com | HTML 메타태그 |

확인 후 양쪽 모두에 `https://mdrop.app/sitemap.xml` 을 제출하세요.

도메인은 **`https://mdrop.app`** 으로 박혀 있습니다. 바꾸려면 `index.html`, `en/index.html`,
`public/robots.txt`, `public/sitemap.xml` 네 곳을 치환하면 됩니다.

`.app` 은 구글 레지스트리 TLD라 국내 등록업체(hosting.kr 등)에서는 취급하지 않습니다. Vercel ·
Cloudflare · Porkbun · Namecheap 에서 구매하세요. Vercel 에서 사면 DNS 가 자동으로 연결됩니다.

## 개발

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # 타입체크 + dist/
npm run preview  # 프로덕션 빌드 확인 — CSP · 서비스워커 · 설치 버튼은 여기서만 동작
```

Vercel 은 별도 설정 없이 Vite 프로젝트로 인식합니다. 정적 파일만 나오므로 어디에 올려도 됩니다.
다만 **서비스 워커와 파일 핸들러는 HTTPS(또는 localhost)에서만** 동작합니다.

`og.png` 와 `shot-*.png` 는 손으로 렌더한 이미지입니다. 히어로 문구를 바꾸면 다시 만들어야
합니다.

## 브라우저별 차이

| | 드롭 · 붙여넣기 | 폴더 · 이미지 | 라이브 리로드 | `.md` 더블클릭 |
| --- | --- | --- | --- | --- |
| Chrome · Edge (데스크톱) | ✅ | ✅ | ✅ | ✅ |
| Firefox · Safari | ✅ | ❌ | ❌ | ❌ |
| 모바일 | ✅ | ❌ | ❌ | ❌ |

폴더 접근과 라이브 리로드는 File System Access API, 더블클릭 연결은 File Handling API 에
의존합니다. 둘 다 현재 Chromium 데스크톱 전용입니다. 미지원 브라우저에서도 드롭과 렌더는
동일하게 동작합니다.

## 알려진 한계

- 매니페스트의 `start_url` 은 `/` 하나뿐입니다. `/en/` 에서 설치해도 앱을 실행하면 한국어
  페이지가 뜹니다 — 상단 언어 링크로 넘어가면 되고, 그 선택은 기억됩니다. 매니페스트를 둘로
  나누면 같은 `.md` 확장자를 두 앱이 다투게 되어 더 나쁩니다.
- Mermaid 와 수식(KaTeX)은 넣지 않았습니다. 합쳐서 1MB 가 넘어 "가벼운 뷰어"라는 전제와
  충돌합니다. 필요하면 코드 하이라이터와 같은 방식(문법을 감지한 뒤 지연 로딩)으로 붙이세요.

## 디자인

색·타이포·질감은 [nan2026.nhn.com](https://nan2026.nhn.com/) 의 디자인 언어를 따랐습니다.
중성 회색이 아닌 **보라빛이 섞인 검정 계단**, 6단계 텍스트 램프, 헤어라인 구분선, 단 하나의
인터랙션 색(민트), 그리고 아주 낮은 강도의 스캔라인·노이즈 텍스처입니다.
참고 캡처는 `docs/design-reference/` 에 있습니다.
