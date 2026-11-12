// The page's words in Korean, English and Japanese: the language the visitor chose (kept), else the browser's.

const WORDS = {
  ko: {
    title: "VoAsync - Lyrics in Sync",
    description: "가사 자동 싱크 소프트웨어",
    spinoffPre: "",
    spinoffPost: "에서 파생된 프로젝트입니다.",
    dictNote: "일본어 사전(약 {mb}MB)을 처음 한 번 받아 이 기기에 저장합니다.",
    disclaimer: "정렬 결과는 정확하지 않을 수 있으며, 후리가나 표시가 틀릴 수 있습니다.",
    licenses: "라이선스",
    local: "모든 데이터는 사용자 기기에서 처리됩니다.",
    song: "노래",
    songHint: "끌어 놓거나 눌러서 선택",
    lyrics: "가사",
    openFile: "파일 열기",
    paste: "가사 붙여넣기",
    start: "싱크 맞추기",
    decode: "디코드",
    spectra: "스펙트럼",
    vocal: "보컬 분석",
    read: "가사 읽기",
    align: "정렬",
    fill: "채우기",
    char: "글자",
    click: "클릭",
    again: "다른 곡",
    download: "내려받기",
    karaokeLrc: "노래방 LRC",
    play: "재생",
    pause: "일시정지",
    position: "위치",
    display: "표시",
    linesSuffix: "줄",
    errSong: "노래 파일을 읽지 못했습니다",
    errAlign: "정렬하지 못했습니다",
    errEngine: "엔진 오류",
    errNoLines: "가사에서 부르는 줄을 찾지 못했습니다",
    errFile: "웹 서버에서 열어 주세요. 예: uv run python -m http.server -d web/dist 8000",
  },
  en: {
    title: "VoAsync - Lyrics in Sync",
    description: "Automatic lyrics sync software",
    spinoffPre: "Derived from ",
    spinoffPost: ".",
    dictNote: "Japanese: a dictionary (about {mb} MB) is downloaded once and kept on this device.",
    disclaimer: "Alignments may be inaccurate, and furigana may be wrong.",
    licenses: "Licenses",
    local: "All data is processed on your device.",
    song: "Song",
    songHint: "Drop a file or click to choose",
    lyrics: "Lyrics",
    openFile: "Open file",
    paste: "Paste lyrics",
    start: "Sync",
    decode: "Decode",
    spectra: "Spectrum",
    vocal: "Vocals",
    read: "Reading",
    align: "Aligning",
    fill: "Fill",
    char: "Character",
    click: "Click",
    again: "New song",
    download: "Download",
    karaokeLrc: "Karaoke LRC",
    play: "Play",
    pause: "Pause",
    position: "Position",
    display: "Display",
    linesSuffix: "lines",
    errSong: "Could not read the song",
    errAlign: "Could not align",
    errEngine: "Engine error",
    errNoLines: "No sung lines in the lyrics",
    errFile: "Open this page from a web server, e.g. uv run python -m http.server -d web/dist 8000",
  },
  ja: {
    title: "VoAsync - Lyrics in Sync",
    description: "歌詞自動同期ソフトウェア",
    spinoffPre: "",
    spinoffPost: " から派生したプロジェクトです。",
    dictNote: "日本語の辞書（約{mb}MB）を初回だけダウンロードし、この端末に保存します。",
    disclaimer: "同期結果は正確でない場合があり、ふりがなが誤っていることがあります。",
    licenses: "ライセンス",
    local: "すべてのデータはお使いの端末で処理されます。",
    song: "曲",
    songHint: "ドロップまたはクリックして選択",
    lyrics: "歌詞",
    openFile: "ファイルを開く",
    paste: "歌詞を貼り付け",
    start: "同期する",
    decode: "デコード",
    spectra: "スペクトル",
    vocal: "ボーカル分析",
    read: "歌詞の読み",
    align: "同期",
    fill: "塗り",
    char: "文字",
    click: "クリック",
    again: "別の曲",
    download: "ダウンロード",
    karaokeLrc: "カラオケLRC",
    play: "再生",
    pause: "一時停止",
    position: "位置",
    display: "表示",
    linesSuffix: "行",
    errSong: "曲を読み込めませんでした",
    errAlign: "同期できませんでした",
    errEngine: "エンジンエラー",
    errNoLines: "歌詞に歌われる行が見つかりません",
    errFile: "Webサーバーから開いてください。例: uv run python -m http.server -d web/dist 8000",
  },
};

export const LANGS = [
  ["ko", "한국어"],
  ["en", "English"],
  ["ja", "日本語"],
];

function initial() {
  const asked = new URLSearchParams(location.search).get("lang"); // a language's own address (?lang=en)
  if (asked && WORDS[asked]) return asked;
  try {
    const kept = localStorage.getItem("voasync.lang");
    if (kept && WORDS[kept]) return kept;
  } catch {
    /* not kept */
  }
  for (const l of navigator.languages || [navigator.language || ""]) {
    const code = l.slice(0, 2).toLowerCase();
    if (WORDS[code]) return code;
  }
  return "en";
}

export let lang = initial();

export const t = (key) => WORDS[lang][key] ?? WORDS.en[key] ?? key;

/** The page's marked elements in the language: data-i18n (text), data-i18n-placeholder, data-i18n-aria; the
 * title and description too. ``chosen``: picked by the visitor (the address then names it). */
export function apply(next = lang, chosen = false) {
  lang = next;
  try {
    localStorage.setItem("voasync.lang", lang);
  } catch {
    /* not kept */
  }
  document.documentElement.lang = lang;
  document.title = t("title");
  document.querySelector('meta[name="description"]')?.setAttribute("content", t("description"));
  if (chosen) {
    const url = new URL(location.href); // the language chosen: its own address (?lang=ko|en|ja)
    url.searchParams.set("lang", lang);
    history.replaceState(null, "", url);
  }
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of document.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  for (const b of document.querySelectorAll("[data-lang]")) b.classList.toggle("on", b.dataset.lang === lang);
}
