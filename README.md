# Gemini 채보 (Gemini Transcriber)

유튜브 URL이나 음악 파일을 넣고 **채보 시작**을 누르면 Gemini API가
**피아노·베이스 기타·어쿠스틱 기타·드럼** 악보와 **코드·가사**를 뽑아 주는 로컬 웹앱입니다.
결과는 피아노 롤·오선 악보(TAB·드럼 보표 포함)·코드/가사 리드시트·드럼 그리드로 보고,
**MIDI / MusicXML / PDF**로 받거나 휴대폰에서 **카톡·메일로 바로 공유**합니다.


> **설치 없이 쓰기**: 동역 웹판 https://hyotowork-create.github.io/dongyeok/tools/transcribe/ (본인 Gemini 키, 악기 분리 제외)
>
> **주의**: 개인 연습용입니다. 저작권이 있는 곡의 악보·가사를 만들어 나누거나 올리거나 파는 것은 저작권 침해가 될 수 있습니다. 유튜브 영상 받기(yt-dlp)는 유튜브 이용약관과 영상 권리자의 허락 범위 안에서만 쓰세요. AI 채보라 틀린 음이 있습니다.

## 어떤 기기에 설치하나

이 앱은 **컴퓨터 한 대에 설치해 서버로 켜 두고**, 그 컴퓨터나 같은 와이파이의 휴대폰 브라우저로 씁니다.
휴대폰에는 설치하지 않습니다.

| 기기 | 설치 | 확인 상태 (2026-11-12) |
|---|---|---|
| 맥 (애플 실리콘·인텔) | 설치해서 서버로 씀 | 새 폴더에 압축 풀어 설치·실행·채보까지 확인 |
| 윈도우 10·11 | 설치해서 서버로 씀 | 윈도우용 코드 수정은 넣었지만 실제 윈도우에서는 아직 안 돌려 봄 |
| 리눅스 | 설치해서 서버로 씀 | 맥과 같은 방식. 80·443 포트는 관리자 권한이 필요해 다른 포트를 씀 |
| 아이폰·아이패드 | 설치 안 함. 사파리로 접속 | iOS 시뮬레이터(iPhone 17)에서 화면·파일 선택·진행·악보·공유 창 확인 |
| 안드로이드 폰 | 설치 안 함. 크롬으로 접속 | 같은 방식으로 될 것으로 보나 실기 미확인 |
| 컴퓨터 없이 휴대폰만 | 동역 웹판을 씀(위 링크) | 본인 Gemini 키 필요, 스템 분리 없음 |

### 맥에 설치

```bash
brew install node ffmpeg yt-dlp          # Homebrew가 없으면 https://brew.sh 먼저
cd gemini-piano-transcriber
npm install                              # "install-scripts" 경고는 무시해도 됩니다
cp .env.example .env
npm start                                # 키는 화면 맨 위 「설정 · Gemini API 키」에서 넣어도 됨
```

### 윈도우에 설치 (PowerShell)

```powershell
winget install OpenJS.NodeJS.LTS Gyan.FFmpeg yt-dlp.yt-dlp
# 휴대폰 공유 창까지 쓰려면 https용 openssl도: winget install ShiningLight.OpenSSL.Light
cd gemini-piano-transcriber
npm install
copy .env.example .env
npm start                                # 키는 화면 맨 위 「설정 · Gemini API 키」에서 넣기
```

### 리눅스에 설치

```bash
sudo apt install nodejs npm ffmpeg && pipx install yt-dlp   # Node는 20.12 이상이어야 함
cd gemini-piano-transcriber && npm install && cp .env.example .env
HTTPS_PORT=3443 HTTP_REDIRECT_PORT=3080 npm start
```

### 준비물 정리

| 항목 | 확인·설치 |
|---|---|
| Node.js 20.12 이상 | `node -v` |
| ffmpeg, ffprobe | 위 설치 명령에 포함 |
| yt-dlp (유튜브 URL을 쓸 때만) | 위 설치 명령에 포함 |
| Gemini API 키 | https://aistudio.google.com/apikey (선불 크레딧이 바닥나면 앱이 한국어로 알려 줌) |
| openssl (휴대폰 공유용 https) | 맥·리눅스는 기본 포함 |
| (선택) Python 3.10 이상 — 스템 분리용 | 아래 "3단계" |

## API 키 넣기·바꾸기

두 가지 방법 중 편한 쪽을 씁니다. 둘 다 같은 `.env` 파일에 저장됩니다.

- **화면에서(휴대폰 포함)**: 맨 위 **⚙ 설정 · Gemini API 키**를 눌러 열고, 새 키를 붙여 넣은 뒤 **저장**.
  - 저장 전에 Gemini에 아주 짧게 물어봐서 진짜 키인지 확인합니다. 틀린 키는 저장하지 않습니다.
  - 크레딧이 바닥난 키는 저장은 하되 노란 글씨로 알려 줍니다.
  - 서버를 다시 켤 필요 없이 바로 적용됩니다.
  - 저장된 키는 화면에 끝 4자리만 보입니다(예: "저장됨 …djjw").
  - 같은 와이파이·핫스팟·테일스케일·이 컴퓨터에서 연 화면에서만 바꿀 수 있습니다.
- **파일로**: 컴퓨터에서 `.env`를 열어 `GEMINI_API_KEY=` 뒤에 키를 넣고 서버를 다시 켭니다.

키는 https://aistudio.google.com/apikey 에서 만듭니다.

## 실행과 접속

`npm start`를 하면 터미널에 주소가 찍힙니다.

- **설치한 컴퓨터에서**: http://localhost:3000
- **아이폰·안드로이드에서** (컴퓨터와 같은 와이파이):
  1. 터미널에 찍힌 `http://192.168.x.x` 주소를 사파리(크롬)에 입력한다. 자동으로 https로 넘어간다.
  2. 처음 한 번 "연결된 네트워크가 비공개가 아님" 경고가 뜬다. 아이폰은 **세부사항 보기 → 이 웹사이트에 방문
     → 웹사이트 방문**을 누른다. 안드로이드는 **고급 → 이동**. 컴퓨터가 스스로 만든 인증서라 뜨는 경고다.
     - 방문을 눌러도 안 열리면: 그 탭을 닫고 새 탭에서 주소를 다시 입력한다. 예전 인증서가 남아 있을 수 있다.
     - 2026-11-12 이전에 만든 인증서는 아이폰 규칙(서버 인증 용도·유효기간 398일 이하)에 맞지 않아 실제 아이폰에서
       방문이 막힐 수 있었다. 지금은 서버가 켜질 때 규칙에 맞는 인증서(`data/certs/*_v2.*`)를 새로 만든다.
  3. 결과 화면의 **공유 (카톡·메일)** 를 누르면 시스템 공유 창에 악보 PDF·리드시트 PDF·MIDI·MusicXML
     네 파일이 담긴다. 여기서 카카오톡이나 메일을 고른다.
- 공유 창은 https 주소에서만 열린다. `http://…:3000`으로 열면 앱이 맨 위에 https로 가는 안내를 띄운다.
- 사무실·카페 같은 공용 와이파이는 기기끼리 연결을 막는 경우가 많다. 그때는 집 와이파이나
  휴대폰 핫스팟에 컴퓨터를 붙인다.
- 컴퓨터가 잠자기에 들어가면 휴대폰에서도 끊긴다.

## 사용법

1. 음악 파일을 끌어다 놓거나 유튜브 URL을 붙여 넣는다.
2. **악기**를 고른다. 피아노(멜로디+반주)가 기본이고 베이스·기타·드럼을 더할 수 있다.
   **스템 분리**를 켜면 Demucs로 악기별 소리를 먼저 분리해 정확도가 오른다(3단계 설치 필요, 곡당 몇 분 더).
3. **채보 시작**. 진행 중에는 **중지**로 끊을 수 있다. **빠른 모드**는 flash-lite 모델을 쓴다.
4. 결과 화면
   - **곡 해설**: 어떤 곡인지, 코드가 어떻게 반복되는지, 난이도, 따라 치는 요령을 비전공자용 한국어로.
   - **피아노 롤**: 파트별 색, 마디 위 코드, 클릭으로 이동. **계이름**을 켜면 건반과 음표에 도레미가 붙는다.
   - **악보**: 피아노 2단 + 베이스/기타(오선+TAB) + 드럼 보표, 마디 위 코드 기호.
     **쉬운 악보**(멜로디 + 코드 근음만, 8분음표 단위)와 **계이름**(음표 아래 도레미) 토글.
   - **코드·가사**: 마디별 코드와 가사 리드시트. 기타·피아노 반주용. 별도 PDF.
   - **드럼 그리드**: 16분음표 격자에 킥·스네어·하이햇 등 표시.
   - 플레이어: 원곡/채보 볼륨, 파트별 켜고 끄기, 재생 속도 0.5x~1.5x.
5. **MIDI 받기 / 악보 받기(MusicXML) / 악보 PDF 받기 / 리드시트 PDF 받기 / 공유(카톡·메일)**.
   MusicXML은 MuseScore·Finale·Sibelius·Dorico에서 열어 다듬을 수 있다.
   다운로드는 지금 켜져 있는 쉬운 악보·계이름 토글을 따른다.

완료된 작업은 `data/jobs/<id>/job.json`에 남아 서버를 다시 켜도 `#job=<id>` 주소로 열립니다.

## 3단계: 스템 분리(Demucs) 설치

```bash
cd gemini-piano-transcriber
python3 -m venv .venv
.venv/bin/pip install demucs numpy
```

`.venv/bin/demucs`가 생기면 화면의 **스템 분리** 체크박스가 켜집니다. 첫 실행 때 모델(약 300MB)을 받습니다.
Apple M4 CPU 기준 1분 곡을 40초 정도에 6개 스템(보컬·드럼·베이스·기타·피아노·기타등)으로 나눕니다.

스템을 켜면 파트별로 다른 소리를 Gemini에 줍니다: 피아노 편곡·코드·가사는 "드럼 뺀 믹스",
베이스·기타·드럼은 각자의 스템. 호출 수는 파트 수만큼 늘어납니다.

## 동작 원리

```
파일/URL → (yt-dlp) → ffmpeg 재생용 mp3 → (Demucs 스템) → 30초 조각(모노 22kHz)
  → 조각마다 Gemini: {bpm, key, timeSignature, chords, lyrics, notes, bass, guitar, drums}
  → 조 보정(음원에서 음별 에너지를 재서, Gemini가 통째로 옮겨 적은 조각을 원래 조로 되돌림)
  → 합치기(BPM 중앙값) · 16분음표 격자 양자화 · 쉬운 버전 생성
  → MIDI(파트별 트랙, 드럼 10번 채널) · MusicXML(여러 파트, TAB, 타악기, <harmony>, 계이름 <lyric>)
  → Gemini 한 번 더: 곡 해설(메타데이터만 보냄)
  → 브라우저: 피아노 롤·드럼 그리드(canvas) · 악보(OpenSheetMusicDisplay) · 리드시트(canvas) · PDF(jsPDF)
```

- 기본 모델 `gemini-3.5-flash` (`.env`의 `GEMINI_MODEL`). 30초 조각당 10~25초. 조각 4개 동시.
- 429/503은 자동 재시도. 15분보다 긴 오디오는 거절(`server/index.js`의 `MAX_DURATION_SEC`).
- 양자화 격자는 16분음표. 셋잇단음표는 가까운 격자로 붙는다.

## 한계 (솔직하게)

- Gemini는 범용 모델이라 전용 채보 모델만큼 정확하지 않다. 코드·가사·멜로디·베이스는 쓸 만하고,
  드럼 세부(고스트 노트·빠른 필인)와 빠른 기타 패시지는 놓친다. 스템 분리를 켜면 눈에 띄게 나아진다.
- 같은 보표에서 시작이 같은 음은 한 화음으로 묶고 길이는 다음 음 시작까지로 자른다.
- 좌우 손은 "양손 나누는 음"(기본 60 = 가운데 도) 기준 단순 분리. TAB 현·프렛은 이동 거리 최소 휴리스틱.
- 조가 중간에 바뀌는 곡은 조표를 하나(최빈값)만 쓴다. 코드 기호와 가사는 그대로 맞는다.

## 모의 모드

`.env`에 `MOCK_GEMINI=1`을 두면 Gemini 없이 가짜 음표·코드·가사·드럼을 만들어 화면만 확인할 수 있다.

## 폴더

```
server/index.js     Express 서버, 업로드·작업 큐·다운로드(easy/solfege 변형)
server/audio.js     yt-dlp, ffmpeg 변환·분할
server/stems.js     Demucs 스템 분리
server/gemini.js    Gemini 호출(파트별 스키마·프롬프트)·파싱·재시도·곡 해설·모의 모드
server/keyfix.js    조 보정(음원 크로마 기준)
server/quantize.js  합치기·양자화·쉬운 버전
server/musicxml.js  MusicXML (여러 파트, TAB, 드럼, 코드 기호, 계이름)
server/midi.js      MIDI (파트별 트랙)
public/             화면 (index.html, app.js, style.css)
test/               node --test
data/               업로드·작업 결과 (git 제외)
.venv/              Demucs (git 제외)
```

## 라이선스

MIT (LICENSE 파일)
