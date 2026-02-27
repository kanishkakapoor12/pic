import { useEffect, useRef, useState } from "react";
import * as Ably from "ably";

const ably = new Ably.Realtime({ key: "YwsqLA.4od-dw:-h2pqc1TD_dMHjdyWJgq81LfPw94Papmq9qQtexgQ6k" });
const channel = ably.channels.get("scribble-global");

const WORDS = [
  "elephant","computer","mountain","airplane","football","pencil","camera",
  "guitar","pizza","rocket","castle","submarine","lighthouse","umbrella",
  "butterfly","telescope","dinosaur","waterfall","sailboat","mushroom",
  "rainbow","volcano","octopus","penguin","treasure","snowflake","bicycle",
  "dragon","tornado","cactus","jellyfish","astronaut","pyramid","compass",
];
const PALETTE = [
  "#000000","#e63946","#f4a261","#f9c74f","#2a9d8f",
  "#457b9d","#a8dadc","#ffffff","#6d4c41","#7b2d8b",
];

const ROUND_TIME = 90;
const REVEAL_INTERVAL = 30;
const TOTAL_ROUNDS = 5;

type Player  = { id: string; name: string; score: number; hasGuessed?: boolean };
type ChatMsg = { id: string; text: string; type: "guess" | "system" | "correct" };
type DrawData = { x0: number; y0: number; x1: number; y1: number; color: string; size: number };
type Phase   = "lobby" | "choosing" | "playing" | "gameOver";

function getMasked(w: string, elapsed: number) {
  const revealed = Math.floor(elapsed / REVEAL_INTERVAL);
  return w.split("").map((c, i) => c === " " ? "/" : i < revealed ? c : "_").join(" ");
}
function pickWords() { return [...WORDS].sort(() => Math.random() - 0.5).slice(0, 3); }

export default function App() {
  // ── All drawing state lives in refs — zero React re-renders on the hot path ──
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const ctxRef       = useRef<CanvasRenderingContext2D | null>(null);
  const lastPosRef   = useRef<{ x: number; y: number } | null>(null);
  const isDrawingRef = useRef(false);
  const colorRef     = useRef("#000000");
  const sizeRef      = useRef(4);
  const eraserRef    = useRef(false);

  // ── Refs for values needed inside Ably/timer callbacks (avoids stale closures) ──
  const meRef        = useRef<Player | null>(null);
  const drawerIdRef  = useRef<string | null>(null);
  const playersRef   = useRef<Player[]>([]);
  const turnRef      = useRef(0);
  const timerRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const chatEndRef   = useRef<HTMLDivElement>(null);

  // ── React state (drives UI re-renders) ──
  const [name, setName]       = useState("");
  const [me, setMe]           = useState<Player | null>(() => {
    try { const s = localStorage.getItem("scribble_me"); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [players, setPlayers] = useState<Player[]>([]);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [turn, setTurn]       = useState(0);
  const [word, setWord]       = useState<string | null>(null);
  const [maskedWord, setMaskedWord] = useState("");
  const [timer, setTimer]     = useState(ROUND_TIME);
  const [chat, setChat]       = useState<ChatMsg[]>([]);
  const [guess, setGuess]     = useState("");
  const [phase, setPhase]     = useState<Phase>("lobby");
  const [wordChoices, setWordChoices] = useState<string[]>([]);

  // ── Toolbar UI state (only triggers toolbar re-render, not canvas) ──
  const [uiColor, setUiColor] = useState("#000000");
  const [uiSize,  setUiSize]  = useState(4);
  const [uiEraser,setUiEraser]= useState(false);

  // Keep refs in sync with state
  useEffect(() => { meRef.current = me; }, [me]);
  useEffect(() => { drawerIdRef.current = drawerId; }, [drawerId]);
  useEffect(() => { playersRef.current = players; }, [players]);
  useEffect(() => { turnRef.current = turn; }, [turn]);

  const round = Math.floor(turn / Math.max(players.length, 1)) + 1;

  // ── Canvas init — runs once, canvas is ALWAYS mounted ──
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctxRef.current = ctx;
  }, []);

  // ── Pointer events — attached once to the always-mounted canvas ──
  useEffect(() => {
    const canvas = canvasRef.current!;

    const getPos = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * (canvas.width  / r.width),
        y: (e.clientY - r.top)  * (canvas.height / r.height),
      };
    };

    const onDown = (e: PointerEvent) => {
      if (meRef.current?.id !== drawerIdRef.current) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      isDrawingRef.current = true;
      lastPosRef.current = getPos(e);
    };

    const onMove = (e: PointerEvent) => {
      if (!isDrawingRef.current || meRef.current?.id !== drawerIdRef.current) return;
      e.preventDefault();
      const pos  = getPos(e);
      const prev = lastPosRef.current;
      if (!prev) { lastPosRef.current = pos; return; }

      const ctx   = ctxRef.current!;
      const col   = eraserRef.current ? "#ffffff" : colorRef.current;
      const width = eraserRef.current ? sizeRef.current * 3 : sizeRef.current;

      ctx.strokeStyle = col;
      ctx.lineWidth   = width;
      ctx.lineCap     = "round";
      ctx.lineJoin    = "round";
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(pos.x,  pos.y);
      ctx.stroke();

      channel.publish("draw", { x0: prev.x, y0: prev.y, x1: pos.x, y1: pos.y, color: col, size: width });
      lastPosRef.current = pos;
    };

    const onUp = (e: PointerEvent) => {
      if (!isDrawingRef.current) return;
      e.preventDefault();
      isDrawingRef.current = false;
      lastPosRef.current   = null;
    };

    canvas.addEventListener("pointerdown",   onDown, { passive: false });
    canvas.addEventListener("pointermove",   onMove, { passive: false });
    canvas.addEventListener("pointerup",     onUp,   { passive: false });
    canvas.addEventListener("pointercancel", onUp,   { passive: false });
    return () => {
      canvas.removeEventListener("pointerdown",   onDown);
      canvas.removeEventListener("pointermove",   onMove);
      canvas.removeEventListener("pointerup",     onUp);
      canvas.removeEventListener("pointercancel", onUp);
    };
  }, []); // empty — everything accessed via refs, no need to re-attach

  const clearCanvas = () => {
    const canvas = canvasRef.current!;
    const ctx    = ctxRef.current!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };

  // ── Join ──
  const join = () => {
    if (!name.trim()) return;
    const player: Player = { id: crypto.randomUUID(), name: name.trim(), score: 0 };
    localStorage.setItem("scribble_me", JSON.stringify(player));
    meRef.current = player;
    setMe(player);
    channel.publish("join", player);
  };

  // ── Re-announce on reload ──
  useEffect(() => {
    const saved = localStorage.getItem("scribble_me");
    if (!saved) return;
    try {
      const p = JSON.parse(saved) as Player;
      meRef.current = p;
      channel.publish("join", p);
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Ably subscription ──
  useEffect(() => {
    const applyDraw = (d: DrawData) => {
      const ctx = ctxRef.current;
      if (!ctx) return;
      ctx.strokeStyle = d.color; ctx.lineWidth = d.size;
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath(); ctx.moveTo(d.x0, d.y0); ctx.lineTo(d.x1, d.y1); ctx.stroke();
    };

    const handler = (msg: Ably.Message) => {
      const d = msg.data;

      if (msg.name === "join") {
        setPlayers(p => p.find(x => x.id === d.id) ? p : [...p, d]);
        setChat(c => [...c, { id: crypto.randomUUID(), text: `${d.name} joined`, type: "system" as const }]);
      }

      if (msg.name === "state") {
        setPlayers(d.players);
        setDrawerId(d.drawerId);
        setWord(d.word ?? null);
        setMaskedWord(d.maskedWord ?? "");
        setTurn(d.turn ?? 0);
        setTimer(d.timer ?? ROUND_TIME);
        setPhase(d.phase ?? "playing");
        if (d.phase === "playing") clearCanvas();
      }

      if (msg.name === "draw")  applyDraw(d as DrawData);
      if (msg.name === "clear") clearCanvas();
      if (msg.name === "chat")  setChat(c => [...c, d as ChatMsg]);

      if (msg.name === "wordChoices") {
        if (meRef.current?.id === d.drawerId) setWordChoices(d.words);
      }

      if (msg.name === "allGuessed") {
        if (meRef.current?.id === drawerIdRef.current) advanceTurn(d.players, d.turn);
      }
    };

    channel.subscribe(handler);
    return () => { channel.unsubscribe(handler); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Timer ──
  useEffect(() => {
    if (phase !== "playing" || !drawerId) return;
    if (timerRef.current) clearInterval(timerRef.current);

    timerRef.current = setInterval(() => {
      setTimer(t => {
        const next = t - 1;
        if (next <= 0) {
          clearInterval(timerRef.current!);
          if (meRef.current?.id === drawerIdRef.current)
            advanceTurn(playersRef.current, turnRef.current);
          return 0;
        }
        return next;
      });
    }, 1000);

    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, drawerId, turn]);

  // ── Word reveal ──
  useEffect(() => {
    if (!word || phase !== "playing" || meRef.current?.id === drawerId) return;
    setMaskedWord(getMasked(word, ROUND_TIME - timer));
  }, [timer, word, phase, drawerId]);

  // ── Auto-scroll chat ──
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chat]);

  // ── Game flow ──
  const advanceTurn = (currentPlayers: Player[], currentTurn: number) => {
    const nextTurn = currentTurn + 1;
    if (nextTurn >= currentPlayers.length * TOTAL_ROUNDS) {
      channel.publish("state", {
        players: currentPlayers, drawerId: null, turn: nextTurn,
        word: null, maskedWord: "", timer: 0, phase: "gameOver",
      });
    } else {
      beginTurn(nextTurn, currentPlayers);
    }
  };

  const beginTurn = (t: number, currentPlayers: Player[]) => {
    const drawer = currentPlayers[t % currentPlayers.length];
    if (!drawer) return;
    channel.publish("wordChoices", { drawerId: drawer.id, words: pickWords() });
    channel.publish("state", {
      players: currentPlayers.map(p => ({ ...p, hasGuessed: false })),
      drawerId: drawer.id, turn: t,
      word: null, maskedWord: null, timer: ROUND_TIME, phase: "choosing",
    });
  };

  const handleWordChoice = (chosen: string) => {
    setWordChoices([]);
    const drawer = playersRef.current[turnRef.current % playersRef.current.length];
    if (!drawer) return;
    channel.publish("state", {
      players: playersRef.current.map(p => ({ ...p, hasGuessed: false })),
      drawerId: drawer.id, turn: turnRef.current,
      word: chosen, maskedWord: getMasked(chosen, 0),
      timer: ROUND_TIME, phase: "playing",
    });
    channel.publish("clear", {});
  };

  // ── Guess ──
  const submitGuess = () => {
    if (!word || !me || me.id === drawerId || !guess.trim()) return;
    if (guess.trim().toLowerCase() === word.toLowerCase()) {
      const pts = Math.max(10, Math.ceil((timer / ROUND_TIME) * 100));
      const updated = players.map(p => p.id === me.id ? { ...p, score: p.score + pts, hasGuessed: true } : p);
      channel.publish("chat", { id: crypto.randomUUID(), text: `🎉 ${me.name} guessed it! (+${pts} pts)`, type: "correct" });
      channel.publish("state", { players: updated, drawerId, turn, word, maskedWord: word.split("").join(" "), timer, phase: "playing" });
      const nonDrawers = updated.filter(p => p.id !== drawerId);
      if (nonDrawers.length > 0 && nonDrawers.every(p => p.hasGuessed))
        channel.publish("allGuessed", { players: updated, turn });
    } else {
      channel.publish("chat", { id: crypto.randomUUID(), text: `${me.name}: ${guess.trim()}`, type: "guess" });
    }
    setGuess("");
  };

  // ── Derived ──
  const sortedPlayers = [...players].sort((a, b) => b.score - a.score);
  const isDrawer      = !!me && me.id === drawerId;
  const drawerName    = players.find(p => p.id === drawerId)?.name ?? "";
  const timerPct      = (timer / ROUND_TIME) * 100;
  const timerColor    = timer > 30 ? "#2a9d8f" : timer > 10 ? "#f4a261" : "#e63946";
  const iHaveGuessed  = !!players.find(p => p.id === me?.id)?.hasGuessed;

  // Show overlay when not in active game
  const showLogin    = !me;
  const showGameOver = phase === "gameOver";
  const showChoose   = phase === "choosing" && isDrawer && wordChoices.length > 0;
  const showOverlay  = showLogin || showGameOver || showChoose;

  /* ══════════════════════════════════════════════════════════════════
     SINGLE RETURN — canvas is always in the DOM so listeners persist
  ══════════════════════════════════════════════════════════════════ */
  return (
    <div style={S.shell}>

      {/* ══ Game UI (always rendered, hidden behind overlay when needed) ══ */}
      <div style={{ ...S.gamePane, visibility: showOverlay ? "hidden" : "visible" }}>

        {/* Top bar */}
        <div style={S.topBar}>
          <div style={S.topLeft}>
            <span style={S.roundBadge}>Round {round}/{TOTAL_ROUNDS}</span>
            <span style={S.drawerLabel}>
              {isDrawer ? "Your turn ✏️" : <>{drawerName} <span style={{ color: "#666" }}>draws</span></>}
            </span>
          </div>
          <div style={S.timerWrap}>
            <span style={{ ...S.timerNum, color: timerColor }}>{timer}</span>
            <svg width="40" height="40" style={{ position: "absolute", top: 0, left: 0, transform: "rotate(-90deg)" }}>
              <circle cx="20" cy="20" r="17" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="3"/>
              <circle cx="20" cy="20" r="17" fill="none" stroke={timerColor} strokeWidth="3"
                strokeDasharray={`${2 * Math.PI * 17}`}
                strokeDashoffset={`${2 * Math.PI * 17 * (1 - timerPct / 100)}`}
                style={{ transition: "stroke-dashoffset 1s linear, stroke 0.5s" }}/>
            </svg>
          </div>
        </div>

        {/* Word bar */}
        <div style={S.wordBar}>
          {!isDrawer && phase === "playing" && !iHaveGuessed &&
            <span style={S.wordLetters}>{maskedWord || "_ _ _ _"}</span>}
          {!isDrawer && phase === "playing" && iHaveGuessed &&
            <span style={{ color: "#43aa8b", fontWeight: 600, fontSize: 13 }}>✅ You guessed it! Others are still playing…</span>}
          {!isDrawer && phase === "choosing" &&
            <span style={{ color: "#777", fontSize: 13 }}>⏳ {drawerName} is choosing a word…</span>}
          {isDrawer && word &&
            <span style={S.wordLetters}>🎨 <b style={{ color: "#f4a261" }}>{word.toUpperCase()}</b></span>}
        </div>

        {/* Players strip */}
        <div style={S.playerStrip}>
          {sortedPlayers.map((p, i) => (
            <div key={p.id} style={{
              ...S.playerPill,
              background: p.id === me?.id ? "rgba(42,157,143,0.22)" : "rgba(255,255,255,0.06)",
              borderColor: p.id === drawerId ? "#2a9d8f" : "transparent",
            }}>
              <span style={{ fontSize: 10, color: "#666" }}>{(["🥇","🥈","🥉"] as string[])[i] ?? `${i+1}`}</span>
              <span style={{ fontSize: 12, fontWeight: 600, maxWidth: 64, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                {p.name}{p.hasGuessed ? "✅" : p.id === drawerId ? "✏️" : ""}
              </span>
              <span style={{ fontSize: 11, color: "#f4a261", fontWeight: 700 }}>{p.score}</span>
            </div>
          ))}
        </div>

        {/* Canvas — always mounted, fills remaining space */}
        <div style={S.canvasArea}>
          <canvas
            ref={canvasRef}
            width={600}
            height={450}
            style={{ ...S.canvas, cursor: isDrawer ? (uiEraser ? "cell" : "crosshair") : "default" }}
          />
        </div>

        {/* Drawer toolbar */}
        {isDrawer && (
          <div style={S.toolbar}>
            <div style={S.colorRow}>
              {PALETTE.map(c => (
                <button key={c} onClick={() => { colorRef.current = c; eraserRef.current = false; setUiColor(c); setUiEraser(false); }}
                  style={{ ...S.colorDot, background: c,
                    outline: uiColor === c && !uiEraser ? "2.5px solid #fff" : "2px solid rgba(255,255,255,0.15)",
                    outlineOffset: "1px",
                    transform: uiColor === c && !uiEraser ? "scale(1.3)" : "scale(1)" }} />
              ))}
              <input type="color" value={uiColor} onChange={e => {
                colorRef.current = e.target.value; eraserRef.current = false;
                setUiColor(e.target.value); setUiEraser(false);
              }} style={S.colorPicker} />
            </div>
            <div style={S.toolRow}>
              <input type="range" min={2} max={24} value={uiSize} onChange={e => {
                sizeRef.current = +e.target.value; setUiSize(+e.target.value);
              }} style={{ flex: 1, accentColor: "#2a9d8f" }} />
              <span style={{ color: "#888", fontSize: 12, width: 20, textAlign: "center" as const }}>{uiSize}</span>
              <button style={{ ...S.toolBtn, background: uiEraser ? "#e63946" : "rgba(255,255,255,0.1)" }}
                onClick={() => { eraserRef.current = !uiEraser; setUiEraser(v => !v); }}>⬜</button>
              <button style={{ ...S.toolBtn, background: "rgba(255,255,255,0.1)" }}
                onClick={() => { channel.publish("clear", {}); clearCanvas(); }}>🗑️</button>
            </div>
          </div>
        )}

        {/* Chat */}
        <div style={S.chatPanel}>
          <div style={S.chatScroll}>
            {chat.length === 0 && <span style={{ color: "#444", fontSize: 12, fontStyle: "italic" }}>No messages yet…</span>}
            {chat.map(c => (
              <div key={c.id} style={{ ...S.chatLine,
                color: c.type === "correct" ? "#43aa8b" : c.type === "system" ? "#555" : "#d4d4d4",
                fontStyle: c.type === "system" ? "italic" : "normal",
                fontSize: c.type === "system" ? 11 : 13,
              }}>{c.text}</div>
            ))}
            <div ref={chatEndRef} />
          </div>
          {!isDrawer && !iHaveGuessed ? (
            <div style={S.inputRow}>
              <input style={S.chatInput} placeholder="Type your guess…" value={guess}
                onChange={e => setGuess(e.target.value)} onKeyDown={e => e.key === "Enter" && submitGuess()} />
              <button style={S.sendBtn} onClick={submitGuess}>↑</button>
            </div>
          ) : (
            <div style={{ padding: "8px 12px", color: "#444", fontSize: 11, fontStyle: "italic", textAlign: "center" as const }}>
              {isDrawer ? "You're drawing — no guessing!" : "✅ Waiting for others…"}
            </div>
          )}
        </div>

        {/* Start button (lobby phase) */}
        {phase === "lobby" && players.length >= 1 && (
          <div style={{ padding: "8px 12px 12px", flexShrink: 0 }}>
            <button style={{ ...S.primaryBtn, width: "100%" }} onClick={() => beginTurn(0, players)}>
              Start · {players.length} player{players.length !== 1 ? "s" : ""} · {players.length * TOTAL_ROUNDS} turns total
            </button>
          </div>
        )}
      </div>

      {/* ══ Overlay screens (rendered on top, canvas stays alive underneath) ══ */}
      {showOverlay && (
        <div style={S.overlay}>

          {/* Login */}
          {showLogin && (
            <div style={S.card}>
              <div style={{ fontSize: 52 }}>✏️</div>
              <h1 style={S.cardTitle}>Scribble</h1>
              <p style={S.cardSub}>Draw &amp; Guess with friends</p>
              <input style={S.textInput} placeholder="Your name…" value={name}
                onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && join()} autoFocus />
              <button style={S.primaryBtn} onClick={join}>Join Game</button>
            </div>
          )}

          {/* Game over */}
          {showGameOver && (
            <div style={S.card}>
              <div style={{ fontSize: 52 }}>🏆</div>
              <h2 style={{ ...S.cardTitle, fontSize: 26 }}>Game Over!</h2>
              <p style={{ ...S.cardSub, color: "#f4a261", fontWeight: 700 }}>{sortedPlayers[0]?.name} wins!</p>
              <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8, margin: "4px 0 8px" }}>
                {sortedPlayers.map((p, i) => (
                  <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "10px 14px", borderRadius: 12,
                    background: i === 0 ? "rgba(244,162,97,0.15)" : "rgba(255,255,255,0.05)" }}>
                    <span style={{ color: i === 0 ? "#f4a261" : "#bbb" }}>
                      {(["🥇","🥈","🥉"] as string[])[i] ?? `#${i+1}`} {p.name}
                    </span>
                    <strong style={{ color: "#fff" }}>{p.score} pts</strong>
                  </div>
                ))}
              </div>
              <button style={S.primaryBtn} onClick={() => { setPhase("lobby"); setTurn(0); setChat([]); clearCanvas(); }}>
                Play Again
              </button>
            </div>
          )}

          {/* Word chooser */}
          {showChoose && (
            <div style={S.card}>
              <div style={{ fontSize: 40 }}>🎨</div>
              <h2 style={{ ...S.cardTitle, fontSize: 22 }}>Pick a word</h2>
              <p style={S.cardSub}>Round {round}/{TOTAL_ROUNDS} · Your turn to draw</p>
              {wordChoices.map(w => (
                <button key={w} style={{ ...S.primaryBtn, letterSpacing: 1 }} onClick={() => handleWordChoice(w)}>
                  {w}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <style>{CSS}</style>
    </div>
  );
}

/* ══════════════════════════════════════════ STYLES ══════════════════════════════════════════ */

const CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body, #root { margin: 0; height: 100%; background: #0d1117; color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    overscroll-behavior: none; overflow: hidden; }
  canvas { display: block; touch-action: none; user-select: none; -webkit-user-select: none; }
  input::placeholder { color: #444; }
  button { -webkit-tap-highlight-color: transparent; }
  ::-webkit-scrollbar { width: 3px; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 4px; }
`;

const S: Record<string, React.CSSProperties> = {
  /* Root shell — full screen */
  shell: { position: "fixed", inset: 0, display: "flex", flexDirection: "column",
    maxWidth: 480, margin: "0 auto", background: "#0d1117" },

  /* Game pane — fills the shell */
  gamePane: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" },

  /* Full-screen overlay for login / gameover / choose */
  overlay: { position: "absolute", inset: 0, zIndex: 10, display: "flex",
    alignItems: "center", justifyContent: "center",
    background: "rgba(13,17,23,0.96)", padding: 20 },

  /* Card inside overlay */
  card: { display: "flex", flexDirection: "column", alignItems: "center", gap: 12,
    background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 24, padding: "28px 24px", width: "100%", maxWidth: 340 },
  cardTitle: { margin: 0, fontSize: 30, fontWeight: 800, letterSpacing: -1 },
  cardSub:   { margin: 0, color: "#666", fontSize: 14 },
  textInput: { width: "100%", background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 12, color: "#fff", padding: "12px 14px", fontSize: 16, outline: "none" },
  primaryBtn: { width: "100%", background: "#2a9d8f", color: "#fff", border: "none",
    borderRadius: 12, padding: "13px 0", fontSize: 15, fontWeight: 700, cursor: "pointer" },

  /* Top bar */
  topBar: { display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "10px 14px", background: "rgba(255,255,255,0.03)",
    borderBottom: "1px solid rgba(255,255,255,0.06)", flexShrink: 0 },
  topLeft:     { display: "flex", flexDirection: "column", gap: 2 },
  roundBadge:  { fontSize: 11, fontWeight: 700, color: "#2a9d8f", letterSpacing: 0.5 },
  drawerLabel: { fontSize: 14, fontWeight: 600, color: "#fff" },
  timerWrap:   { position: "relative", width: 40, height: 40, flexShrink: 0 },
  timerNum:    { position: "absolute", inset: 0, display: "flex", alignItems: "center",
    justifyContent: "center", fontSize: 13, fontWeight: 800 } as React.CSSProperties,

  /* Word bar */
  wordBar: { display: "flex", alignItems: "center", justifyContent: "center",
    padding: "5px 14px", minHeight: 34, flexShrink: 0,
    background: "rgba(255,255,255,0.02)", borderBottom: "1px solid rgba(255,255,255,0.05)" },
  wordLetters: { fontSize: 20, fontWeight: 700, letterSpacing: 5 },

  /* Player strip */
  playerStrip: { display: "flex", gap: 6, overflowX: "auto", padding: "5px 10px",
    flexShrink: 0, borderBottom: "1px solid rgba(255,255,255,0.05)" },
  playerPill: { display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
    padding: "4px 8px", borderRadius: 10, flexShrink: 0, minWidth: 58,
    border: "1px solid transparent" },

  /* Canvas */
  canvasArea: { flex: 1, minHeight: 0, background: "#fff", display: "flex" },
  canvas:     { width: "100%", height: "100%" },

  /* Toolbar */
  toolbar:    { flexShrink: 0, background: "rgba(255,255,255,0.04)",
    borderTop: "1px solid rgba(255,255,255,0.07)", padding: "7px 10px",
    display: "flex", flexDirection: "column", gap: 6 },
  colorRow:   { display: "flex", gap: 5, flexWrap: "wrap" as const, alignItems: "center" },
  colorDot:   { width: 24, height: 24, borderRadius: "50%", cursor: "pointer", border: "none",
    outline: "none", flexShrink: 0, transition: "transform 0.1s, outline 0.1s" },
  colorPicker:{ width: 24, height: 24, border: "none", background: "none", cursor: "pointer", padding: 0, flexShrink: 0 },
  toolRow:    { display: "flex", gap: 8, alignItems: "center" },
  toolBtn:    { color: "#fff", border: "none", borderRadius: 8, padding: "5px 10px", fontSize: 16, cursor: "pointer" },

  /* Chat */
  chatPanel:  { flexShrink: 0, maxHeight: "25%", background: "rgba(255,255,255,0.025)",
    borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", flexDirection: "column" },
  chatScroll: { flex: 1, overflowY: "auto", padding: "5px 12px",
    display: "flex", flexDirection: "column", gap: 1 },
  chatLine:   { fontSize: 13, lineHeight: 1.5, wordBreak: "break-word" as const, padding: "1px 0" },
  inputRow:   { display: "flex", gap: 6, padding: "6px 10px",
    borderTop: "1px solid rgba(255,255,255,0.05)", flexShrink: 0 },
  chatInput:  { flex: 1, background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 20, color: "#fff", padding: "9px 14px", fontSize: 14, outline: "none" },
  sendBtn:    { width: 38, height: 38, borderRadius: "50%", background: "#2a9d8f", color: "#fff",
    border: "none", fontSize: 18, cursor: "pointer", flexShrink: 0,
    display: "flex", alignItems: "center", justifyContent: "center" },
};
