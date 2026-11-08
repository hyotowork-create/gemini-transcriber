# Gemini 채보 (Gemini Transcriber)

유튜브 URL이나 음악 파일을 넣고 **채보 시작**을 누르면 Gemini API가
**피아노·베이스 기타·어쿠스틱 기타·드럼** 악보와 **코드·가사**를 뽑아 주는 로컬 웹앱입니다.
결과는 피아노 롤·오선 악보(TAB·드럼 보표 포함)·코드/가사 리드시트·드럼 그리드로 보고,
**MIDI / MusicXML / PDF**로 받거나 휴대폰에서 **카톡·메일로 바로 공유**합니다.


> **설치 없이 쓰기**: 동역 웹판 https://hyotowork-create.github.io/dongyeok/tools/transcribe/ (본인 Gemini 키, 악기 분리 제외)
>
> **주의**: 개인 연습용입니다. 저작권이 있는 곡의 악보·가사를 만들어 나누거나 올리거나 파는 것은 저작권 침해가 될 수 있습니다. 유튜브 영상 받기(yt-dlp)는 유튜브 이용약관과 영상 권리자의 허락 범위 안에서만 쓰세요. AI 채보라 틀린 음이 있습니다.

## 준비물

| 항목 | 확인·설치 |
|---|---|
| Node.js 20 이상 | `node -v` |
| ffmpeg, ffprobe | `brew install ffmpeg` |
| yt-dlp (유튜브 URL을 쓸 때만) | `brew install yt-dlp` |
| Gemini API 키 | https://aistudio.google.com/apikey |
| (선택) Python 3.10 이상 — 스템 분리용 | `python3 --version` |

## 실행

```bash
cd gemini-piano-transcriber
npm install
cp .env.example .env     # 이미 .env가 있으면 생략
```

`.env`의 `GEMINI_API_KEY=` 뒤에 키를 붙여 넣고:

```bash
npm start
```

http://localhost:3000 을 엽니다. 서버가 켜질 때 찍어 주는 `http://192.168.x.x:3000` 주소를
휴대폰(같은 와이파이)에서 열면 공유 버튼이 카카오톡·메일 공유 창을 띄웁니다.

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
