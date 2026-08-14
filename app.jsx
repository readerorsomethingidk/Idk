import React, { useState, useRef, useEffect, useCallback } from "react";
import { Play, Pause, Square, Settings, BookOpen, Sparkles, Download, Plus, X } from "lucide-react";

const SAMPLE_TEXT = `The lighthouse keeper had not spoken to another soul in eleven days. It was not loneliness that troubled him, exactly, but a kind of static that built up behind his ribs when there was no one to spend his words on.

He wrote them instead, in a ledger meant for weather. Fog, he wrote. Fog like a held breath. The gulls know something I don't.

On the twelfth day, a boat appeared on the horizon, small and stubborn against the gray. He watched it for an hour before he let himself believe it was real, and then he began, quietly, to practice the sound of his own voice. Dr. Alden used to say that Mr. Byrne's charts were wrong, but Ji-woo never trusted the old maps either.`;

const AI_VOICES = [
  { id: "en-US-AvaMultilingualNeural", label: "Ava (US, natural female)" },
  { id: "en-US-AndrewMultilingualNeural", label: "Andrew (US, warm male)" },
  { id: "en-GB-RyanNeural", label: "Ryan (UK, male)" },
  { id: "en-GB-SoniaNeural", label: "Sonia (UK, female)" },
];

const CJK_VOICE = { ko: "ko-KR-SunHiNeural", zh: "zh-CN-XiaoxiaoNeural", ja: "ja-JP-NanamiNeural" };
const LANG_LABEL = { ko: "Korean", zh: "Chinese", ja: "Japanese" };

const LOOKAHEAD = 3;
const ABBR = new Set(["mr","mrs","ms","dr","st","jr","sr","vs","etc","e.g","i.e","prof","rev","gen","col","sgt","capt","lt","mt","ave","no","inc","ltd","co"]);

function splitSentencesSmart(para) {
  const raw = para.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [para];
  const merged = [];
  raw.forEach((s) => {
    const trimmed = s.trim();
    if (!trimmed) return;
    const prev = merged[merged.length - 1];
    const abbrMatch = prev && prev.match(/(\w+)\.\s*$/);
    if (prev && abbrMatch && ABBR.has(abbrMatch[1].toLowerCase())) {
      merged[merged.length - 1] = prev + " " + trimmed;
    } else {
      merged.push(trimmed);
    }
  });
  return merged;
}

function splitIntoChunks(text) {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  const chunks = [];
  paragraphs.forEach((para, pi) => {
    const sentences = splitSentencesSmart(para);
    sentences.forEach((s, si) => {
      chunks.push({ text: s, paraIndex: pi, isParaEnd: si === sentences.length - 1 });
    });
  });
  return chunks;
}

function detectScript(ch) {
  const code = ch.codePointAt(0);
  if (code >= 0x3040 && code <= 0x30ff) return "ja";
  if (code >= 0xac00 && code <= 0xd7a3) return "ko";
  if (code >= 0x4e00 && code <= 0x9fff) return "zh";
  return null;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Splits sentence text into voice segments: dictionary names get their
// language's native voice, auto-detected CJK script runs too, everything
// else gets the base English voice.
function buildSegments(text, dict, baseVoice) {
  let pieces = [{ text, tag: null }];
  [...dict].sort((a, b) => b.name.length - a.name.length).forEach((entry) => {
    const re = new RegExp(`(?<![A-Za-z])(${escapeRe(entry.name)})(?![A-Za-z])`, "gi");
    const next = [];
    pieces.forEach((p) => {
      if (p.tag) { next.push(p); return; }
      let last = 0, m;
      while ((m = re.exec(p.text))) {
        if (m.index > last) next.push({ text: p.text.slice(last, m.index), tag: null });
        next.push({ text: m[0], tag: entry.lang });
        last = m.index + m[0].length;
      }
      if (last < p.text.length) next.push({ text: p.text.slice(last), tag: null });
      if (last === 0 && p.text.length === 0) { /* noop */ }
    });
    pieces = next.length ? next : pieces;
  });

  const final = [];
  pieces.forEach((p) => {
    if (p.tag) { final.push(p); return; }
    let buf = "", bufScript = null;
    for (const ch of p.text) {
      const s = detectScript(ch);
      if (s !== bufScript) {
        if (buf) final.push({ text: buf, tag: bufScript });
        buf = ch; bufScript = s;
      } else buf += ch;
    }
    if (buf) final.push({ text: buf, tag: bufScript });
  });

  return final.filter((p) => p.text.trim()).map((p) => ({ text: p.text, voice: p.tag ? CJK_VOICE[p.tag] : baseVoice }));
}

function hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// --- Minimal IndexedDB wrapper for persistent audio caching ---
const DB_NAME = "gapless-tts-cache";
const STORE = "audio";
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch { return null; }
}
async function idbSet(key, blob) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* cache is best-effort */ }
}

export default function NovelReader() {
  const [rawText, setRawText] = useState(SAMPLE_TEXT);
  const [chunks, setChunks] = useState(() => splitIntoChunks(SAMPLE_TEXT));
  const [stage, setStage] = useState("edit");
  const [playing, setPlaying] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [queuedUpTo, setQueuedUpTo] = useState(-1);
  const [showSettings, setShowSettings] = useState(false);

  const [engine, setEngine] = useState("browser");
  const [proxyUrl, setProxyUrl] = useState("");
  const [aiVoice, setAiVoice] = useState(AI_VOICES[0].id);
  const [aiStatus, setAiStatus] = useState("");
  const [downloadStatus, setDownloadStatus] = useState("");

  const [pronunciationDict, setPronunciationDict] = useState([]);
  const [dictLoaded, setDictLoaded] = useState(false);
  const [newName, setNewName] = useState("");
  const [newLang, setNewLang] = useState("ko");

  const [voices, setVoices] = useState([]);
  const [voiceURI, setVoiceURI] = useState("");
  const [rate, setRate] = useState(1);

  const chunkRef = useRef(chunks);
  const stoppedRef = useRef(true);
  const audioElRef = useRef(null);
  const audioCacheRef = useRef({});
  const playIndexRef = useRef(-1);
  const bookIdRef = useRef(hashText(rawText));
  const aiFailCountRef = useRef(0);

  useEffect(() => { chunkRef.current = chunks; }, [chunks]);

  // --- load / save pronunciation dictionary (persists across books) ---
  useEffect(() => {
    try {
      const raw = localStorage.getItem("pronunciation-dict");
      if (raw) setPronunciationDict(JSON.parse(raw));
    } catch { /* nothing saved yet */ }
    setDictLoaded(true);
  }, []);
  useEffect(() => {
    if (!dictLoaded) return;
    try { localStorage.setItem("pronunciation-dict", JSON.stringify(pronunciationDict)); } catch {}
  }, [pronunciationDict, dictLoaded]);

  // --- resume position per book ---
  useEffect(() => {
    if (stage !== "reading") return;
    try {
      const raw = localStorage.getItem(`book-pos:${bookIdRef.current}`);
      if (raw) {
        const saved = JSON.parse(raw);
        if (typeof saved.index === "number" && saved.index < chunkRef.current.length && saved.index > 0) {
          setActiveIndex(saved.index);
          playIndexRef.current = saved.index;
        }
      }
    } catch { /* fresh book */ }
  }, [stage]);
  useEffect(() => {
    if (stage !== "reading" || activeIndex < 0) return;
    try { localStorage.setItem(`book-pos:${bookIdRef.current}`, JSON.stringify({ index: activeIndex })); } catch {}
  }, [activeIndex, stage]);

  useEffect(() => {
    function loadVoices() {
      const v = window.speechSynthesis.getVoices();
      if (v.length) {
        setVoices(v);
        setVoiceURI((prev) => prev || v.find((x) => /en/i.test(x.lang))?.voiceURI || v[0].voiceURI);
      }
    }
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    return () => { window.speechSynthesis.cancel(); };
  }, []);

  // ---------- AI engine ----------
  const fetchChunkAudio = useCallback(async (idx) => {
    const cache = audioCacheRef.current;
    if (cache[idx] === "loading" || (cache[idx] && cache[idx] !== "error")) return;
    const chunk = chunkRef.current[idx];
    if (!chunk) return;
    cache[idx] = "loading";
    const cacheKey = `${bookIdRef.current}:${idx}:${aiVoice}`;
    try {
      const cachedBlob = await idbGet(cacheKey);
      if (cachedBlob) {
        cache[idx] = URL.createObjectURL(cachedBlob);
        setQueuedUpTo((q) => Math.max(q, idx));
        return;
      }
      const segments = buildSegments(chunk.text, pronunciationDict, aiVoice);
      const parts = [];
      for (const seg of segments) {
        const res = await fetch(`${proxyUrl.replace(/\/$/, "")}/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: seg.text, voice: seg.voice }),
        });
        if (!res.ok) throw new Error(await res.text());
        parts.push(await res.blob());
      }
      const merged = new Blob(parts, { type: "audio/mpeg" });
      idbSet(cacheKey, merged);
      cache[idx] = URL.createObjectURL(merged);
      setQueuedUpTo((q) => Math.max(q, idx));
      setAiStatus("");
      aiFailCountRef.current = 0;
    } catch (e) {
      cache[idx] = "error";
      aiFailCountRef.current += 1;
      if (aiFailCountRef.current >= 3) {
        setEngine("browser");
        setAiStatus("AI voice kept failing — switched to browser voice");
      } else {
        setAiStatus("error: " + String(e.message || e).slice(0, 80));
      }
    }
  }, [proxyUrl, aiVoice, pronunciationDict]);

  const prefetchAhead = useCallback((fromIdx) => {
    for (let i = fromIdx; i < Math.min(fromIdx + LOOKAHEAD, chunkRef.current.length); i++) fetchChunkAudio(i);
  }, [fetchChunkAudio]);

  const playAiFrom = useCallback(async (idx) => {
    playIndexRef.current = idx;
    stoppedRef.current = false;
    setActiveIndex(idx);
    prefetchAhead(idx);

    let waited = 0;
    while (audioCacheRef.current[idx] === "loading" && waited < 15000) {
      await new Promise((r) => setTimeout(r, 150));
      waited += 150;
    }
    const src = audioCacheRef.current[idx];
    if (!src || src === "error" || stoppedRef.current || playIndexRef.current !== idx) return;

    const el = audioElRef.current;
    el.src = src;
    el.playbackRate = rate;
    try { await el.play(); setPlaying(true); }
    catch { setAiStatus("playback blocked — tap play again"); }
  }, [prefetchAhead, rate]);

  useEffect(() => {
    const el = audioElRef.current;
    if (!el) return;
    const onEnded = () => {
      if (stoppedRef.current) return;
      const next = playIndexRef.current + 1;
      if (next < chunkRef.current.length) playAiFrom(next);
      else { setPlaying(false); setActiveIndex(-1); }
    };
    el.addEventListener("ended", onEnded);
    return () => el.removeEventListener("ended", onEnded);
  }, [playAiFrom]);

  // ---------- Browser engine ----------
  const makeUtterance = useCallback((chunk, idx) => {
    const u = new SpeechSynthesisUtterance(chunk.text);
    const v = voices.find((x) => x.voiceURI === voiceURI);
    if (v) u.voice = v;
    u.rate = rate;
    u.onstart = () => {
      setActiveIndex(idx);
      setQueuedUpTo((q) => Math.max(q, Math.min(idx + LOOKAHEAD, chunkRef.current.length - 1)));
    };
    u.onend = () => {
      if (idx === chunkRef.current.length - 1 && !stoppedRef.current) {
        setPlaying(false); setActiveIndex(-1); stoppedRef.current = true;
      }
    };
    return u;
  }, [voices, voiceURI, rate]);

  const startBrowserReading = useCallback((fromIndex) => {
    window.speechSynthesis.cancel();
    stoppedRef.current = false;
    chunkRef.current.slice(fromIndex).map((c, i) => makeUtterance(c, fromIndex + i)).forEach((u) => window.speechSynthesis.speak(u));
    setPlaying(true);
  }, [makeUtterance]);

  // ---------- Shared controls ----------
  const handlePlayPause = useCallback(() => {
    if (engine === "ai") {
      if (!proxyUrl) { setAiStatus("error: paste your worker URL in Settings first"); setShowSettings(true); return; }
      const el = audioElRef.current;
      if (playing) { el.pause(); setPlaying(false); }
      else if (el.src && playIndexRef.current === activeIndex) { el.play(); setPlaying(true); }
      else { playAiFrom(activeIndex >= 0 ? activeIndex : 0); }
      return;
    }
    if (playing) { window.speechSynthesis.pause(); setPlaying(false); }
    else if (window.speechSynthesis.paused) { window.speechSynthesis.resume(); setPlaying(true); }
    else { startBrowserReading(activeIndex >= 0 ? activeIndex : 0); }
  }, [engine, proxyUrl, playing, activeIndex, playAiFrom, startBrowserReading]);

  const handleStop = useCallback(() => {
    stoppedRef.current = true;
    window.speechSynthesis.cancel();
    if (audioElRef.current) { audioElRef.current.pause(); audioElRef.current.removeAttribute("src"); }
    playIndexRef.current = -1;
    setPlaying(false); setActiveIndex(-1); setQueuedUpTo(-1);
  }, []);

  const handleChunkClick = useCallback((idx) => {
    stoppedRef.current = true;
    window.speechSynthesis.cancel();
    if (engine === "ai") playAiFrom(idx);
    else startBrowserReading(idx);
  }, [engine, playAiFrom, startBrowserReading]);

  // ---------- Media Session (lock screen / car controls) ----------
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const currentText = chunks[activeIndex]?.text;
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: currentText ? currentText.slice(0, 60) : "Reading",
      artist: "Gapless Reader",
    });
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    navigator.mediaSession.setActionHandler("play", handlePlayPause);
    navigator.mediaSession.setActionHandler("pause", handlePlayPause);
    navigator.mediaSession.setActionHandler("previoustrack", () => handleChunkClick(Math.max(0, activeIndex - 1)));
    navigator.mediaSession.setActionHandler("nexttrack", () => handleChunkClick(Math.min(chunks.length - 1, activeIndex + 1)));
    return () => {
      ["play", "pause", "previoustrack", "nexttrack"].forEach((a) => {
        try { navigator.mediaSession.setActionHandler(a, null); } catch {}
      });
    };
  }, [playing, activeIndex, chunks, handlePlayPause, handleChunkClick]);

  const goToReading = () => {
    audioCacheRef.current = {};
    bookIdRef.current = hashText(rawText);
    setChunks(splitIntoChunks(rawText));
    setActiveIndex(-1);
    setStage("reading");
  };

  const addDictEntry = () => {
    const name = newName.trim();
    if (!name) return;
    setPronunciationDict((d) => [...d, { name, lang: newLang }]);
    setNewName("");
  };
  const removeDictEntry = (i) => setPronunciationDict((d) => d.filter((_, idx) => idx !== i));

  const downloadChapter = async () => {
    if (!proxyUrl) { setDownloadStatus("error: set worker URL first"); return; }
    const list = chunkRef.current;
    for (let i = 0; i < list.length; i++) {
      setDownloadStatus(`Preparing ${i + 1}/${list.length}…`);
      await fetchChunkAudio(i);
      if (audioCacheRef.current[i] === "error") { setDownloadStatus(`Failed on sentence ${i + 1}`); return; }
    }
    setDownloadStatus("Merging…");
    const blobs = await Promise.all(list.map(async (_, i) => {
      const url = audioCacheRef.current[i];
      const r = await fetch(url);
      return r.blob();
    }));
    const finalBlob = new Blob(blobs, { type: "audio/mpeg" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(finalBlob);
    a.download = "chapter.mp3";
    a.click();
    setDownloadStatus("Downloaded.");
  };

  const bufferDots = Array.from({ length: LOOKAHEAD }, (_, i) => {
    const idx = activeIndex + i;
    if (idx < 0 || idx >= chunks.length) return false;
    if (engine === "ai") return audioCacheRef.current[idx] && audioCacheRef.current[idx] !== "loading" && audioCacheRef.current[idx] !== "error";
    return idx <= queuedUpTo;
  });

  if (stage === "edit") {
    return (
      <div style={styles.page}>
        <div style={styles.editWrap}>
          <div style={styles.brand}>
            <BookOpen size={20} color="#E8A33D" strokeWidth={1.75} />
            <span style={styles.brandText}>Gapless</span>
          </div>
          <h1 style={styles.editTitle}>Paste your text</h1>
          <p style={styles.editSub}>Full EPUB/PDF import comes next — for now, drop in a passage to hear the buffering engine at work.</p>
          <textarea style={styles.textarea} value={rawText} onChange={(e) => setRawText(e.target.value)} spellCheck={false} />
          <button style={styles.primaryBtn} onClick={goToReading}>Start reading</button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <audio ref={audioElRef} playsInline style={{ display: "none" }} />
      <div style={styles.topBar}>
        <button style={styles.iconBtn} onClick={() => { handleStop(); setStage("edit"); }} title="Back to text">
          <BookOpen size={17} color="#8A8FA3" strokeWidth={1.75} />
        </button>
        <div style={styles.bufferRow} title="Lookahead buffer">
          {bufferDots.map((filled, i) => <span key={i} style={{ ...styles.bufferDot, background: filled ? "#E8A33D" : "#2A2F42" }} />)}
        </div>
        <button style={styles.iconBtn} onClick={() => setShowSettings((s) => !s)}>
          <Settings size={17} color="#8A8FA3" strokeWidth={1.75} />
        </button>
      </div>

      {showSettings && (
        <div style={styles.settingsPanel}>
          <div style={styles.engineToggle}>
            <button style={{ ...styles.engineBtn, ...(engine === "browser" ? styles.engineBtnActive : {}) }} onClick={() => { handleStop(); setEngine("browser"); }}>
              Browser voice
            </button>
            <button style={{ ...styles.engineBtn, ...(engine === "ai" ? styles.engineBtnActive : {}) }} onClick={() => { handleStop(); setEngine("ai"); }}>
              <Sparkles size={13} style={{ marginRight: 5, verticalAlign: -2 }} />
              AI voice (free)
            </button>
          </div>

          {engine === "browser" ? (
            <>
              <label style={styles.settingLabel}>Voice</label>
              <select style={styles.select} value={voiceURI} onChange={(e) => setVoiceURI(e.target.value)}>
                {voices.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>)}
              </select>
              <p style={styles.settingNote}>Browser voices may pause when your screen locks — use AI voice for reliable background/car playback.</p>
            </>
          ) : (
            <>
              <label style={styles.settingLabel}>Worker URL</label>
              <input style={styles.select} placeholder="https://your-worker.workers.dev" value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)} />
              <label style={styles.settingLabel}>Voice</label>
              <select style={styles.select} value={aiVoice} onChange={(e) => setAiVoice(e.target.value)}>
                {AI_VOICES.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
              {aiStatus && <p style={styles.errorNote}>{aiStatus}</p>}

              <label style={styles.settingLabel}>Name pronunciation (Korean / Chinese / Japanese)</label>
              {pronunciationDict.map((entry, i) => (
                <div key={i} style={styles.dictRow}>
                  <span style={styles.dictName}>{entry.name}</span>
                  <span style={styles.dictLang}>{LANG_LABEL[entry.lang]}</span>
                  <button style={styles.dictRemove} onClick={() => removeDictEntry(i)}><X size={13} color="#8A8FA3" /></button>
                </div>
              ))}
              <div style={styles.dictAddRow}>
                <input style={{ ...styles.select, flex: 1 }} placeholder="e.g. Ji-woo" value={newName} onChange={(e) => setNewName(e.target.value)} />
                <select style={styles.select} value={newLang} onChange={(e) => setNewLang(e.target.value)}>
                  <option value="ko">Korean</option>
                  <option value="zh">Chinese</option>
                  <option value="ja">Japanese</option>
                </select>
                <button style={styles.dictAddBtn} onClick={addDictEntry}><Plus size={15} color="#14171F" /></button>
              </div>
              <p style={styles.settingNote}>Any native Korean/Chinese/Japanese script in the text is voiced automatically — this list is for romanized names (e.g. "Ji-woo") so they're spoken correctly instead of read as English.</p>

              <button style={styles.downloadBtn} onClick={downloadChapter}>
                <Download size={14} color="#E8A33D" style={{ marginRight: 6, verticalAlign: -2 }} />
                Download this chapter as MP3
              </button>
              {downloadStatus && <p style={styles.settingNote}>{downloadStatus}</p>}
            </>
          )}

          <label style={styles.settingLabel}>Speed: {rate.toFixed(2)}x</label>
          <input type="range" min="0.6" max="1.8" step="0.05" value={rate} onChange={(e) => setRate(parseFloat(e.target.value))} style={styles.slider} />
        </div>
      )}

      <div style={styles.readingPane}>
        {chunks.map((c, idx) => (
          <span key={idx} onClick={() => handleChunkClick(idx)} style={{ ...styles.sentence, ...(idx === activeIndex ? styles.sentenceActive : {}) }}>
            {c.text}{c.isParaEnd ? "\n\n" : " "}
          </span>
        ))}
      </div>

      <div style={styles.controlBar}>
        <button style={styles.controlBtn} onClick={handleStop}>
          <Square size={16} color="#8A8FA3" strokeWidth={1.75} fill="#8A8FA3" />
        </button>
        <button style={styles.playBtn} onClick={handlePlayPause}>
          {playing ? <Pause size={22} color="#14171F" strokeWidth={2} fill="#14171F" /> : <Play size={22} color="#14171F" strokeWidth={2} fill="#14171F" />}
        </button>
        <div style={styles.rateChip}>{engine === "ai" ? "AI" : "Browser"}</div>
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: "100vh", background: "#14171F", fontFamily: "'Source Sans Pro', system-ui, sans-serif", color: "#E8E3D3", display: "flex", flexDirection: "column" },
  editWrap: { maxWidth: 640, margin: "0 auto", padding: "48px 24px", display: "flex", flexDirection: "column", gap: 14, width: "100%", boxSizing: "border-box" },
  brand: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 },
  brandText: { fontFamily: "'Lora', Georgia, serif", fontSize: 15, letterSpacing: "0.06em", textTransform: "uppercase", color: "#8A8FA3" },
  editTitle: { fontFamily: "'Lora', Georgia, serif", fontSize: 30, fontWeight: 600, margin: "4px 0 0" },
  editSub: { color: "#8A8FA3", fontSize: 14.5, lineHeight: 1.5, margin: "0 0 8px" },
  textarea: { width: "100%", minHeight: 260, background: "#1C2030", border: "1px solid #2A2F42", borderRadius: 10, padding: 16, color: "#E8E3D3", fontFamily: "'Lora', Georgia, serif", fontSize: 16, lineHeight: 1.7, resize: "vertical", boxSizing: "border-box", outline: "none" },
  primaryBtn: { background: "#E8A33D", color: "#14171F", border: "none", borderRadius: 10, padding: "14px 20px", fontSize: 15.5, fontWeight: 600, fontFamily: "'Source Sans Pro', system-ui, sans-serif", cursor: "pointer" },
  topBar: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #1F2333", position: "sticky", top: 0, background: "#14171F", zIndex: 2 },
  iconBtn: { background: "none", border: "none", cursor: "pointer", padding: 6, display: "flex" },
  bufferRow: { display: "flex", gap: 6 },
  bufferDot: { width: 6, height: 6, borderRadius: "50%", transition: "background 0.25s ease" },
  settingsPanel: { padding: "16px 20px", borderBottom: "1px solid #1F2333", display: "flex", flexDirection: "column", gap: 8, background: "#181B29" },
  engineToggle: { display: "flex", gap: 8, marginBottom: 6 },
  engineBtn: { flex: 1, background: "#1C2030", border: "1px solid #2A2F42", borderRadius: 8, padding: "9px 10px", color: "#8A8FA3", fontSize: 13, cursor: "pointer" },
  engineBtnActive: { background: "rgba(232, 163, 61, 0.14)", borderColor: "#E8A33D", color: "#F3EFE2" },
  settingLabel: { fontSize: 12.5, color: "#8A8FA3", textTransform: "uppercase", letterSpacing: "0.05em", marginTop: 6 },
  select: { background: "#1C2030", color: "#E8E3D3", border: "1px solid #2A2F42", borderRadius: 8, padding: "8px 10px", fontSize: 14, fontFamily: "inherit" },
  slider: { width: "100%" },
  settingNote: { fontSize: 12.5, color: "#63687C", lineHeight: 1.5, marginTop: 8 },
  errorNote: { fontSize: 12.5, color: "#E88C6E", lineHeight: 1.5, marginTop: 4 },
  dictRow: { display: "flex", alignItems: "center", gap: 8, background: "#1C2030", border: "1px solid #2A2F42", borderRadius: 8, padding: "6px 10px" },
  dictName: { flex: 1, fontSize: 13.5, color: "#E8E3D3" },
  dictLang: { fontSize: 12, color: "#8A8FA3" },
  dictRemove: { background: "none", border: "none", cursor: "pointer", display: "flex" },
  dictAddRow: { display: "flex", gap: 6 },
  dictAddBtn: { background: "#E8A33D", border: "none", borderRadius: 8, width: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" },
  downloadBtn: { marginTop: 8, background: "#1C2030", border: "1px solid #2A2F42", borderRadius: 8, padding: "10px 12px", color: "#E8E3D3", fontSize: 13.5, cursor: "pointer", textAlign: "left" },
  readingPane: { flex: 1, maxWidth: 640, margin: "0 auto", padding: "36px 24px 140px", fontFamily: "'Lora', Georgia, serif", fontSize: 19, lineHeight: 1.85, whiteSpace: "pre-wrap" },
  sentence: { cursor: "pointer", borderRadius: 4, transition: "background 0.3s ease, color 0.3s ease", color: "#B9B5A6" },
  sentenceActive: { background: "rgba(232, 163, 61, 0.16)", color: "#F3EFE2", boxShadow: "0 0 0 1px rgba(232, 163, 61, 0.22)" },
  controlBar: { position: "fixed", bottom: 0, left: 0, right: 0, background: "rgba(20, 23, 31, 0.92)", backdropFilter: "blur(8px)", borderTop: "1px solid #1F2333", padding: "16px 24px 22px", display: "flex", alignItems: "center", justifyContent: "center", gap: 20 },
  controlBtn: { background: "#1C2030", border: "1px solid #2A2F42", borderRadius: "50%", width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" },
  playBtn: { background: "#E8A33D", border: "none", borderRadius: "50%", width: 56, height: 56, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" },
  rateChip: { background: "#1C2030", border: "1px solid #2A2F42", borderRadius: 20, padding: "8px 14px", fontSize: 13, color: "#8A8FA3", minWidth: 40, textAlign: "center" },
};
