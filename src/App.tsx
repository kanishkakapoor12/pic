import { useEffect, useRef, useState, useCallback } from "react";
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

const ROUND_TIME = 90;       // seconds per turn
const REVEAL_INTERVAL = 30;  // reveal a letter every N seconds
const TOTAL_ROUNDS = 5;      // each player draws this many times

type Player = { id: string; name: string; score: number; hasGuessed?: boolean };
type ChatMsg = { id: string; text: string; type: "guess" | "system" | "correct" };
type DrawData = { x0: number; y0: number; x1: number; y1: number; color: string; size: number };
type Phase = "lobby" | "choosing" | "playing" | "turnEnd" | "gameOver";

// ─── helpers outside component so they never change identity ───
function getMasked(w: string, elapsed: number) {
  const revealed = Math.floor(elapsed / REVEAL_INTERVAL);
  return w.split("").map((c, i) => c === " " ? "/" : i < revealed ? c : "_").join(" ");
}
function pickWords() { return [...WORDS].sort(() => Math.random() - 0.5).slice(0, 3); }

export default function App() {
  // ── canvas / drawing refs — NO React state for hot-path drawing ──
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const ctxRef      = useRef<CanvasRenderingContext2D | null>(null);
  const lastPos     = useRef<{ x: number; y: number } | null>(null);
  const isDrawingRef = useRef(false);
  const colorRef    = useRef("#000000");
  const sizeRef     = useRef(4);
  const eraserRef   = useRef(false);

  // ── other refs to avoid stale closures in Ably handlers ──
  const meRef       = useRef<Player | null>(null);
  const playersRef  = useRef<Player[]>([]);
  const roundRef    = useRef(1);
  const turnRef     = useRef(0);          // absolute turn index across entire game
  const wordRef     = useRef<string | null>(null);
  const drawerIdRef = useRef<string | null>(null);
  const timerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const chatEndRef  = useRef<HTMLDivElement>(null);

  // ── React state (UI only) ──
  const [name, setName]           = useState("");
  const [me, setMe]               = useState<Player | null>(() => {
    try { const s = localStorage.getItem("scribble_me"); return s ? JSON.parse(s) : null; }
    catch { return null; }
  });
  const [players, setPlayers]     = useState<Player[]>([]);
  const [drawerId, setDrawerId]   = useState<string | null>(null);
  const [turn, setTurn]           = useState(0);
  const [word, setWord]           = useState<string | null>(null);
  const [maskedWord, setMaskedWord] = useState("");
  const [timer, setTimer]         = useState(ROUND_TIME);
  const [chat, setChat]           = useState<ChatMsg[]>([]);
  const [guess, setGuess]         = useState("");
  const [phase, setPhase]         = useState<Phase>("lobby");
  const [wordChoices, setWordChoices] = useState<string[]>([]);

  // ── UI-only drawing state (for toolbar re-renders only) ──
  const [uiColor, setUiColor]     = useState("#000000");
  const [uiSize, setUiSize]       = useState(4);
  const [uiEraser, setUiEraser]   = useState(false);

  // Keep refs in sync with state
  useEffect(() => { meRef.current = me; }, [me]);
  useEffect(() => { playersRef.current = players; }, [players]);
  useEffect(() => { roundRef.current = Math.floor(turn / Math.max(players.length, 1)) + 1; }, [turn, players.length]);
  useEffect(() => { turnRef.current = turn; }, [turn]);
  useEffect(() => { wordRef.current = word; }, [word]);
  useEffect(() => { drawerIdRef.current = drawerId; }, [drawerId]);

  const round = Math.floor(turn / Math.max(players.length, 1)) + 1;
  const totalTurns = players.length * TOTAL_ROUNDS;

  // ── canvas init ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctxRef.current = ctx;
  }, []);

  const clearCanvas = useCallback(() => {
    const ctx = ctxRef.current;
    const canvas = canvasRef.current;
    if (!ctx || !canvas) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, []);

  // ── join ──
  const join = () => {
    if (!name.trim()) return;
    const player: Player = { id: crypto.randomUUID(), name: name.trim(), score: 0 };
    localStorage.setItem("scribble_me", JSON.stringify(player));
    meRef.current = player;
    setMe(player);
    channel.publish("join", player);
  };

  // ── re-announce on reload ──
  useEffect(() => {
    const saved = localStorage.getItem("scribble_me");
    if (!saved) return;
    try {
      const player = JSON.parse(saved) as Player;
      meRef.current = player;
      channel.publish("join", player);
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── ABLY subscription ──
  useEffect(() => {
    const drawLine = (d: DrawData) => {
      const ctx = ctxRef.current;
      if (!ctx) return;
      ctx.strokeStyle = d.color;
      ctx.lineWidth = d.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(d.x0, d.y0);
      ctx.lineTo(d.x1, d.y1);
      ctx.stroke();
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

      if (msg.name === "draw") drawLine(d as DrawData);
      if (msg.name === "clear") clearCanvas();
      if (msg.name === "chat") setChat(c => [...c, d as ChatMsg]);

      if (msg.name === "wordChoices") {
        if (meRef.current?.id === d.drawerId) setWordChoices(d.words);
      }

      // When all guessers are done, advance turn
      if (msg.name === "allGuessed") {
        // Only the current drawer advances to avoid duplicate calls
        if (meRef.current?.id === drawerIdRef.current) {
          advanceTurn(d.players, d.turn);
        }
      }
    };

    channel.subscribe(handler);
    return () => { channel.unsubscribe(handler); };
  }, [clearCanvas]);

  // ── timer ──
  useEffect(() => {
    if (phase !== "playing" || !drawerId) return;
    if (timerRef.current) clearInterval(timerRef.current);

    timerRef.current = setInterval(() => {
      setTimer(t => {
        const next = t - 1;
        if (next <= 0) {
          clearInterval(timerRef.current!);
          // Timer ran out — drawer advances turn
          if (meRef.current?.id === drawerIdRef.current) {
            advanceTurn(playersRef.current, turnRef.current);
          }
          return 0;
        }
        return next;
      });
    }, 1000);

    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, drawerId, turn]);

  // ── word reveal for guessers ──
  useEffect(() => {
    if (!word || phase !== "playing") return;
    if (meRef.current?.id === drawerId) return;
    setMaskedWord(getMasked(word, ROUND_TIME - timer));
  }, [timer, word, phase, drawerId]);

  // ── auto-scroll chat ──
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat]);

  // ── game flow ──
  // FIX 3: turn = absolute index across whole game. round = floor(turn / nPlayers) + 1
  const advanceTurn = (currentPlayers: Player[], currentTurn: number) => {
    const nextTurn = currentTurn + 1;
    const total = currentPlayers.length * TOTAL_ROUNDS;
    if (nextTurn >= total) {
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
    const choices = pickWords();
    channel.publish("wordChoices", { drawerId: drawer.id, words: choices });
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

  // ── guess ──
  // FIX 1: Don't end turn on first guess. Mark player as guessed, check if ALL guessed.
  const submitGuess = () => {
    if (!word || !me || me.id === drawerId || !guess.trim()) return;

    if (guess.trim().toLowerCase() === word.toLowerCase()) {
      const points = Math.max(10, Math.ceil((timer / ROUND_TIME) * 100));
      const updated = players.map(p =>
        p.id === me.id ? { ...p, score: p.score + points, hasGuessed: true } : p
      );

      channel.publish("chat", {
        id: crypto.randomUUID(),
        text: `🎉 ${me.name} guessed it! (+${points} pts)`,
        type: "correct",
      });

      // Check if ALL non-drawers have now guessed
      const nonDrawers = updated.filter(p => p.id !== drawerId);
      const allGuessed = nonDrawers.length > 0 && nonDrawers.every(p => p.hasGuessed);

      // Publish updated scores (keep playing)
      channel.publish("state", {
        players: updated, drawerId, turn, word,
        maskedWord: word.split("").join(" "),
        timer, phase: "playing",
      });

      if (allGuessed) {
        // Notify everyone that all guessers are done — drawer will advance
        channel.publish("allGuessed", { players: updated, turn });
      }
    } else {
      channel.publish("chat", {
        id: crypto.randomUUID(),
        text: `${me.name}: ${guess.trim()}`,
        type: "guess",
      });
    }
    setGuess("");
  };

  // ── SMOOTH DRAWING: use Pointer Events + refs, zero React state on hot path ──
  const getPos = (e: PointerEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top)  * (canvas.height / rect.height),
    };
  };

  // Attach pointer events directly to canvas via ref — bypasses React synthetic event overhead
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onDown = (e: PointerEvent) => {
      if (meRef.current?.id !== drawerIdRef.current) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId); // smooth even when cursor leaves canvas briefly
      isDrawingRef.current = true;
      lastPos.current = getPos(e);
    };

    const onMove = (e: PointerEvent) => {
      if (!isDrawingRef.current || meRef.current?.id !== drawerIdRef.current) return;
      e.preventDefault();
      const pos = getPos(e);
      const prev = lastPos.current;
      if (!prev) { lastPos.current = pos; return; }

      const ctx = ctxRef.current!;
      const drawColor = eraserRef.current ? "#ffffff" : colorRef.current;
      const drawSize  = eraserRef.current ? sizeRef.current * 3 : sizeRef.current;

      // Draw locally with zero latency
      ctx.strokeStyle = drawColor;
      ctx.lineWidth   = drawSize;
      ctx.lineCap     = "round";
      ctx.lineJoin    = "round";
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();

      // Broadcast to others
      channel.publish("draw", { x0: prev.x, y0: prev.y, x1: pos.x, y1: pos.y, color: drawColor, size: drawSize });
      lastPos.current = pos;
    };

    const onUp = (e: PointerEvent) => {
      if (!isDrawingRef.current) return;
      e.preventDefault();
      isDrawingRef.current = false;
      lastPos.current = null;
    };

    canvas.addEventListener("pointerdown", onDown, { passive: false });
    canvas.addEventListener("pointermove", onMove, { passive: false });
    canvas.addEventListener("pointerup",   onUp,   { passive: false });
    canvas.addEventListener("pointercancel", onUp, { passive: false });

    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup",   onUp);
      canvas.removeEventListener("pointercancel", onUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — all mutable state accessed via refs

  // ── derived ──
  const sortedPlayers = [...players].sort((a, b) => b.score - a.score);
  const isDrawer = !!me && me.id === drawerId;
  const drawerName = players.find(p => p.id === drawerId)?.name ?? "";
  const timerPct = (timer / ROUND_TIME) * 100;
  const timerColor = timer > 30 ? "#2a9d8f" : timer > 10 ? "#f4a261" : "#e63946";
  const myPlayer = players.find(p => p.id === me?.id);
  const iHaveGuessed = !!myPlayer?.hasGuessed;

  /* ════════════════════════════════ SCREENS ════════════════════════════════ */

  if (!me) {
    return (
      <div style={S.screen}>
        <div style={S.loginCard}>
          <div style={S.logo}>✏️</div>
          <h1 style={S.logoTitle}>Scribble</h1>
          <p style={S.logoSub}>Draw &amp; Guess with friends</p>
          <input style={S.textInput} placeholder="Enter your name…" value={name}
            onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && join()} autoFocus />
          <button style={S.primaryBtn} onClick={join}>Join Game</button>
        </div>
        <style>{CSS}</style>
      </div>
    );
  }

  if (phase === "gameOver") {
    const winner = sortedPlayers[0];
    return (
      <div style={S.screen}>
        <div style={S.loginCard}>
          <div style={{ fontSize: 48 }}>🏆</div>
          <h2 style={{ ...S.logoTitle, fontSize: 28 }}>Game Over!</h2>
          <p style={{ ...S.logoSub, color: "#f4a261", fontWeight: 600 }}>{winner?.name} wins!</p>
          <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8, margin: "8px 0" }}>
            {sortedPlayers.map((p, i) => (
              <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderRadius: 12, background: i === 0 ? "rgba(244,162,97,0.18)" : "rgba(255,255,255,0.05)" }}>
                <span style={{ fontSize: 15, color: i === 0 ? "#f4a261" : "#ccc" }}>
                  {(["🥇","🥈","🥉"] as string[])[i] ?? `#${i+1}`} {p.name}
                </span>
                <span style={{ fontWeight: 700, color: "#fff" }}>{p.score} pts</span>
              </div>
            ))}
          </div>
          <button style={S.primaryBtn} onClick={() => { setPhase("lobby"); setTurn(0); setChat([]); clearCanvas(); }}>
            Play Again
          </button>
        </div>
        <style>{CSS}</style>
      </div>
    );
  }

  if (phase === "choosing" && isDrawer && wordChoices.length > 0) {
    return (
      <div style={S.screen}>
        <div style={S.loginCard}>
          <div style={{ fontSize: 36 }}>🎨</div>
          <h2 style={{ color: "#fff", margin: "0 0 4px", fontSize: 20, fontWeight: 700 }}>Pick a word to draw</h2>
          <p style={{ color: "#666", fontSize: 13, margin: "0 0 16px" }}>Round {round}/{TOTAL_ROUNDS} · Your turn</p>
          {wordChoices.map(w => (
            <button key={w} style={{ ...S.primaryBtn, marginBottom: 10, width: "100%", letterSpacing: 1 }} onClick={() => handleWordChoice(w)}>
              {w}
            </button>
          ))}
        </div>
        <style>{CSS}</style>
      </div>
    );
  }

  /* ════════════════════════════════ MAIN GAME ════════════════════════════════ */
  // FIX 2: True mobile-app layout — fixed full-screen, no scroll, bottom input bar
  return (
    <div style={S.appShell}>
      {/* ── Top bar ── */}
      <div style={S.topBar}>
        <div style={S.topLeft}>
          <span style={S.roundBadge}>R{round}/{TOTAL_ROUNDS}</span>
          <span style={S.drawerLabel}>
            {isDrawer ? "Your turn ✏️" : <>{drawerName} <span style={{ color: "#777" }}>draws</span></>}
          </span>
        </div>
        <div style={S.timerWrap}>
          <span style={{ ...S.timerText, color: timerColor }}>{timer}</span>
          <svg width="36" height="36" style={{ position: "absolute", top: 0, left: 0, transform: "rotate(-90deg)" }}>
            <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="3" />
            <circle cx="18" cy="18" r="15" fill="none" stroke={timerColor} strokeWidth="3"
              strokeDasharray={`${2 * Math.PI * 15}`}
              strokeDashoffset={`${2 * Math.PI * 15 * (1 - timerPct / 100)}`}
              style={{ transition: "stroke-dashoffset 1s linear, stroke 0.5s" }} />
          </svg>
        </div>
      </div>

      {/* ── Word / status bar ── */}
      <div style={S.wordBar}>
        {!isDrawer && phase === "playing" && !iHaveGuessed &&
          <span style={S.wordLetters}>{maskedWord || "_ _ _ _"}</span>}
        {!isDrawer && phase === "playing" && iHaveGuessed &&
          <span style={{ color: "#43aa8b", fontWeight: 600, fontSize: 14 }}>✅ You guessed it! Watch others…</span>}
        {!isDrawer && phase === "choosing" &&
          <span style={{ color: "#888", fontSize: 13 }}>⏳ {drawerName} is choosing a word…</span>}
        {isDrawer && word &&
          <span style={S.wordLetters}>🎨 <b style={{ color: "#f4a261" }}>{word.toUpperCase()}</b></span>}
      </div>

      {/* ── Players strip ── */}
      <div style={S.playerStrip}>
        {sortedPlayers.map((p, i) => (
          <div key={p.id} style={{
            ...S.playerPill,
            background: p.id === me.id ? "rgba(42,157,143,0.25)" : "rgba(255,255,255,0.07)",
            borderColor: p.id === drawerId ? "#2a9d8f" : "transparent",
          }}>
            <span style={{ fontSize: 10, color: "#777" }}>{(["🥇","🥈","🥉"] as string[])[i] ?? `${i+1}`}</span>
            <span style={{ fontSize: 12, fontWeight: 600, maxWidth: 64, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
              {p.name}{p.hasGuessed ? "✅" : p.id === drawerId ? "✏️" : ""}
            </span>
            <span style={{ fontSize: 11, color: "#f4a261", fontWeight: 700 }}>{p.score}</span>
          </div>
        ))}
      </div>

      {/* ── Canvas — fills remaining space ── */}
      <div style={S.canvasArea}>
        <canvas
          ref={canvasRef}
          width={600}
          height={450}
          style={{ ...S.canvas, cursor: isDrawer ? (uiEraser ? "cell" : "crosshair") : "default" }}
        />
      </div>

      {/* ── Drawer toolbar ── */}
      {isDrawer && (
        <div style={S.toolbar}>
          <div style={S.colorRow}>
            {PALETTE.map(c => (
              <button key={c} onClick={() => {
                colorRef.current = c; eraserRef.current = false;
                setUiColor(c); setUiEraser(false);
              }} style={{
                ...S.colorDot, background: c,
                border: uiColor === c && !uiEraser ? "2.5px solid #fff" : "2px solid rgba(255,255,255,0.15)",
                transform: uiColor === c && !uiEraser ? "scale(1.35)" : "scale(1)",
              }} />
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
            <span style={{ color: "#aaa", fontSize: 12, width: 22 }}>{uiSize}</span>
            <button style={{ ...S.toolBtn, background: uiEraser ? "#e63946" : "rgba(255,255,255,0.1)" }}
              onClick={() => { eraserRef.current = !eraserRef.current; setUiEraser(e => !e); }}>
              ⬜
            </button>
            <button style={{ ...S.toolBtn, background: "rgba(255,255,255,0.1)" }}
              onClick={() => { channel.publish("clear", {}); clearCanvas(); }}>
              🗑️
            </button>
          </div>
        </div>
      )}

      {/* ── Chat + input (bottom sheet) ── */}
      <div style={S.chatPanel}>
        <div style={S.chatScroll}>
          {chat.length === 0 && <span style={{ color: "#444", fontSize: 13, fontStyle: "italic" }}>No messages yet…</span>}
          {chat.map(c => (
            <div key={c.id} style={{
              ...S.chatLine,
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
          <div style={{ padding: "8px 12px", color: "#444", fontSize: 12, fontStyle: "italic", textAlign: "center" as const }}>
            {isDrawer ? "You're drawing — no guessing!" : "You already guessed correctly 🎉"}
          </div>
        )}
      </div>

      {/* ── Start button in lobby ── */}
      {phase === "lobby" && players.length >= 1 && (
        <div style={{ padding: "0 12px 12px" }}>
          <button style={{ ...S.primaryBtn, width: "100%" }} onClick={() => beginTurn(0, players)}>
            Start Game · {players.length} player{players.length !== 1 ? "s" : ""} · {players.length * TOTAL_ROUNDS} turns
          </button>
        </div>
      )}

      <style>{CSS}</style>
    </div>
  );
}

/* ══════════════════════════════════════ STYLES ══════════════════════════════════════ */

const CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0d1117; color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    overscroll-behavior: none; overflow: hidden; }
  #root { height: 100%; }
  canvas { display: block; touch-action: none; user-select: none; -webkit-user-select: none; }
  input::placeholder { color: #444; }
  button { -webkit-tap-highlight-color: transparent; }
  ::-webkit-scrollbar { width: 3px; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 4px; }
`;

const S: Record<string, React.CSSProperties> = {
  /* ── full-screen shell ── */
  appShell: {
    position: "fixed", inset: 0,
    display: "flex", flexDirection: "column",
    background: "#0d1117",
    maxWidth: 480, margin: "0 auto",   // centred column on desktop, full screen on mobile
  },

  /* ── lobby / modal screens ── */
  screen: {
    position: "fixed", inset: 0,
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "#0d1117", padding: 20,
  },
  loginCard: {
    display: "flex", flexDirection: "column", alignItems: "center", gap: 12,
    background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 24, padding: "32px 28px", width: "100%", maxWidth: 340,
  },
  logo:      { fontSize: 48, lineHeight: 1 },
  logoTitle: { margin: 0, fontSize: 32, fontWeight: 800, letterSpacing: -1 },
  logoSub:   { margin: 0, color: "#666", fontSize: 14 },
  textInput: {
    width: "100%", background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 12, color: "#fff", padding: "12px 14px", fontSize: 16, outline: "none",
  },
  primaryBtn: {
    width: "100%", background: "#2a9d8f", color: "#fff", border: "none",
    borderRadius: 12, padding: "13px 0", fontSize: 16, fontWeight: 700, cursor: "pointer",
  },

  /* ── top bar ── */
  topBar: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "10px 14px",
    background: "rgba(255,255,255,0.03)", borderBottom: "1px solid rgba(255,255,255,0.06)",
    flexShrink: 0,
  },
  topLeft:     { display: "flex", flexDirection: "column", gap: 2 },
  roundBadge:  { fontSize: 11, fontWeight: 700, color: "#2a9d8f", letterSpacing: 0.5 },
  drawerLabel: { fontSize: 14, fontWeight: 600, color: "#fff" },
  timerWrap:   { position: "relative", width: 36, height: 36, flexShrink: 0 },
  timerText:   { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 800 } as React.CSSProperties,

  /* ── word bar ── */
  wordBar: {
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: "6px 14px", minHeight: 36, flexShrink: 0,
    background: "rgba(255,255,255,0.02)", borderBottom: "1px solid rgba(255,255,255,0.05)",
  },
  wordLetters: { fontSize: 20, fontWeight: 700, letterSpacing: 5 },

  /* ── player strip ── */
  playerStrip: {
    display: "flex", gap: 6, overflowX: "auto", padding: "6px 10px",
    flexShrink: 0, borderBottom: "1px solid rgba(255,255,255,0.05)",
  },
  playerPill: {
    display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
    padding: "5px 8px", borderRadius: 10, flexShrink: 0, minWidth: 60,
    border: "1px solid transparent",
  },

  /* ── canvas ── */
  canvasArea: {
    flex: 1, minHeight: 0,       // fills all remaining space
    background: "#fff",
    display: "flex", alignItems: "stretch",
  },
  canvas: { width: "100%", height: "100%" },

  /* ── toolbar ── */
  toolbar: {
    flexShrink: 0,
    background: "rgba(255,255,255,0.04)", borderTop: "1px solid rgba(255,255,255,0.07)",
    padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6,
  },
  colorRow:   { display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" } as React.CSSProperties,
  colorDot:   { width: 24, height: 24, borderRadius: "50%", cursor: "pointer", outline: "none", flexShrink: 0, transition: "transform 0.1s" },
  colorPicker:{ width: 24, height: 24, border: "none", background: "none", cursor: "pointer", padding: 0, flexShrink: 0 },
  toolRow:    { display: "flex", gap: 8, alignItems: "center" },
  toolBtn:    { color: "#fff", border: "none", borderRadius: 8, padding: "5px 10px", fontSize: 16, cursor: "pointer" },

  /* ── chat panel ── */
  chatPanel: {
    flexShrink: 0, maxHeight: "26%",
    background: "rgba(255,255,255,0.03)", borderTop: "1px solid rgba(255,255,255,0.07)",
    display: "flex", flexDirection: "column",
  },
  chatScroll: {
    flex: 1, overflowY: "auto", padding: "6px 12px",
    display: "flex", flexDirection: "column", gap: 1,
  },
  chatLine: { fontSize: 13, lineHeight: 1.5, wordBreak: "break-word" as const, padding: "1px 0" },
  inputRow: { display: "flex", gap: 6, padding: "6px 10px", borderTop: "1px solid rgba(255,255,255,0.06)", flexShrink: 0 },
  chatInput: {
    flex: 1, background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 20, color: "#fff", padding: "9px 14px", fontSize: 14, outline: "none",
  },
  sendBtn: {
    width: 38, height: 38, borderRadius: "50%", background: "#2a9d8f", color: "#fff",
    border: "none", fontSize: 18, cursor: "pointer", flexShrink: 0,
    display: "flex", alignItems: "center", justifyContent: "center",
  },
};
