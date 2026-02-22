import { useEffect, useRef, useState, useCallback } from "react";
import * as Ably from "ably";

const ably = new Ably.Realtime({ key: "YwsqLA.4od-dw:-h2pqc1TD_dMHjdyWJgq81LfPw94Papmq9qQtexgQ6k" });
const channel = ably.channels.get("scribble-global");

const WORDS = [
  "elephant", "computer", "mountain", "airplane", "football",
  "pencil", "camera", "guitar", "pizza", "rocket", "castle",
  "submarine", "lighthouse", "umbrella", "butterfly", "telescope",
  "dinosaur", "waterfall", "sailboat", "mushroom", "rainbow",
  "volcano", "octopus", "penguin", "treasure", "snowflake",
];

const COLORS = [
  "#111111", "#e63946", "#f4a261", "#2a9d8f", "#457b9d",
  "#a8dadc", "#ffffff", "#6d4c41", "#7b2d8b", "#43aa8b",
];

const ROUND_TIME = 90;
const LETTER_REVEAL_INTERVAL = 30;
const TOTAL_ROUNDS = 5;

type Player = { id: string; name: string; score: number; hasGuessed?: boolean };
type ChatMsg = { id: string; text: string; type: "guess" | "system" | "correct" };
type DrawData = { x0: number; y0: number; x1: number; y1: number; color: string; size: number };
type GamePhase = "lobby" | "playing" | "roundEnd" | "gameOver" | "choosing";

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // meRef lets Ably callbacks always read the latest player without stale closures
  const meRef = useRef<Player | null>(null);

  const [name, setName] = useState("");
  const [me, setMe] = useState<Player | null>(() => {
    try {
      const saved = localStorage.getItem("scribble_me");
      return saved ? (JSON.parse(saved) as Player) : null;
    } catch { return null; }
  });
  const [players, setPlayers] = useState<Player[]>([]);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [round, setRound] = useState(1);
  const [word, setWord] = useState<string | null>(null);
  const [maskedWord, setMaskedWord] = useState("");
  const [timer, setTimer] = useState(ROUND_TIME);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [guess, setGuess] = useState("");
  const [phase, setPhase] = useState<GamePhase>("lobby");
  const [roundWinner, setRoundWinner] = useState<string | null>(null);
  const [wordChoices, setWordChoices] = useState<string[]>([]);

  const [color, setColor] = useState("#111111");
  const [size, setSize] = useState(4);
  const [isEraser, setIsEraser] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);

  // Keep meRef in sync
  useEffect(() => { meRef.current = me; }, [me]);

  /* ── helpers ── */
  const getMasked = (w: string, elapsed: number) => {
    const revealed = Math.floor(elapsed / LETTER_REVEAL_INTERVAL);
    return w.split("").map((c, i) => (c === " " ? "/" : i < revealed ? c : "_")).join(" ");
  };

  const pickWords = () => [...WORDS].sort(() => Math.random() - 0.5).slice(0, 3);

  /* ── canvas helpers ── */
  const drawLine = useCallback((ctx: CanvasRenderingContext2D, d: DrawData) => {
    ctx.strokeStyle = d.color;
    ctx.lineWidth = d.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(d.x0, d.y0);
    ctx.lineTo(d.x1, d.y1);
    ctx.stroke();
  }, []);

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, []);

  /* ── join ── */
  const join = () => {
    if (!name.trim()) return;
    const player: Player = { id: crypto.randomUUID(), name: name.trim(), score: 0 };
    localStorage.setItem("scribble_me", JSON.stringify(player));
    meRef.current = player;
    setMe(player);
    channel.publish("join", player);
  };

  /* ── re-announce on reload ── */
  useEffect(() => {
    const saved = localStorage.getItem("scribble_me");
    if (!saved) return;
    try {
      const player = JSON.parse(saved) as Player;
      meRef.current = player;
      channel.publish("join", player);
    } catch { /* ignore corrupt storage */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── ably subscription ── */
  useEffect(() => {
    // We pass a named handler so we can cleanly unsubscribe it.
    // All setChat calls are done inline here — NEVER via an outside helper
    // function, because those helpers capture a stale closure on mount.
    const handler = (msg: Ably.Message) => {
      const d = msg.data;

      if (msg.name === "join") {
        setPlayers((p) => (p.find((x) => x.id === d.id) ? p : [...p, d]));
        setChat((c) => [
          ...c,
          { id: crypto.randomUUID(), text: `${d.name} joined the game`, type: "system" as const },
        ]);
      }

      if (msg.name === "state") {
        setPlayers(d.players);
        setDrawerId(d.drawerId);
        setWord(d.word ?? null);
        setMaskedWord(d.maskedWord ?? "");
        setRound(d.round);
        setTimer(d.timer ?? ROUND_TIME);
        setPhase(d.phase ?? "playing");
        setRoundWinner(d.roundWinner ?? null);
        if (d.phase === "playing") clearCanvas();
      }

      if (msg.name === "draw") {
        const ctx = canvasRef.current?.getContext("2d");
        if (ctx) drawLine(ctx, d as DrawData);
      }

      if (msg.name === "clear") clearCanvas();

      // FIX: use setChat updater directly — avoids stale closure entirely
      if (msg.name === "chat") {
        setChat((c) => [...c, d as ChatMsg]);
      }

      if (msg.name === "wordChoices") {
        // Use meRef, not state — this callback is created once at mount
        // and would otherwise always see the initial null value of `me`
        if (meRef.current?.id === d.drawerId) {
          setWordChoices(d.words);
        }
      }
    };

    channel.subscribe(handler);
    return () => { channel.unsubscribe(handler); };
  }, [drawLine, clearCanvas]);

  /* ── timer ── */
  useEffect(() => {
    if (phase !== "playing" || !drawerId) return;
    if (timerRef.current) clearInterval(timerRef.current);

    timerRef.current = setInterval(() => {
      setTimer((t) => {
        const next = t - 1;
        if (next <= 0) { if (timerRef.current) clearInterval(timerRef.current); return 0; }
        return next;
      });
    }, 1000);

    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [phase, drawerId, round]);

  /* ── word reveal ── */
  useEffect(() => {
    if (!word || phase !== "playing") return;
    if (meRef.current?.id === drawerId) return; // drawer already knows
    setMaskedWord(getMasked(word, ROUND_TIME - timer));
  }, [timer, word, phase, drawerId]);

  /* ── auto-scroll chat ── */
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat]);

  /* ── game flow ── */
  const startRound = (r: number, chosenWord: string, currentPlayers: Player[]) => {
    const drawer = currentPlayers[(r - 1) % currentPlayers.length];
    if (!drawer) return;
    channel.publish("state", {
      players: currentPlayers.map((p) => ({ ...p, hasGuessed: false })),
      drawerId: drawer.id, round: r,
      word: chosenWord, maskedWord: getMasked(chosenWord, 0),
      timer: ROUND_TIME, phase: "playing", roundWinner: null,
    });
    channel.publish("clear", {});
  };

  const beginRound = useCallback((r: number, currentPlayers: Player[]) => {
    const drawer = currentPlayers[(r - 1) % currentPlayers.length];
    if (!drawer) return;
    const choices = pickWords();
    channel.publish("wordChoices", { drawerId: drawer.id, words: choices });
    channel.publish("state", {
      players: currentPlayers, drawerId: drawer.id, round: r,
      word: null, maskedWord: null, timer: ROUND_TIME, phase: "choosing", roundWinner: null,
    });
  }, []);

  const handleWordChoice = (chosen: string) => {
    setWordChoices([]);
    startRound(round, chosen, players);
  };

  /* ── guess ── */
  const submitGuess = () => {
    if (!word || !me || me.id === drawerId || !guess.trim()) return;

    if (guess.trim().toLowerCase() === word.toLowerCase()) {
      const points = Math.max(10, Math.ceil((timer / ROUND_TIME) * 100));
      const updated = players.map((p) =>
        p.id === me.id ? { ...p, score: p.score + points, hasGuessed: true } : p
      );
      channel.publish("chat", { id: crypto.randomUUID(), text: `🎉 ${me.name} guessed it! (+${points} pts)`, type: "correct" });
      channel.publish("state", { players: updated, drawerId, round, word, maskedWord: word.split("").join(" "), timer, phase: "playing", roundWinner: me.name });
      setTimeout(() => {
        if (round >= TOTAL_ROUNDS) {
          channel.publish("state", { players: updated, drawerId, round, word, maskedWord: "", timer: 0, phase: "gameOver", roundWinner: me.name });
        } else {
          beginRound(round + 1, updated);
        }
      }, 3000);
    } else {
      channel.publish("chat", { id: crypto.randomUUID(), text: `${me.name}: ${guess.trim()}`, type: "guess" });
    }
    setGuess("");
  };

  /* ── drawing ── */
  const getPos = (e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    const cx = "touches" in e ? e.touches[0].clientX : e.clientX;
    const cy = "touches" in e ? e.touches[0].clientY : e.clientY;
    return { x: (cx - rect.left) * sx, y: (cy - rect.top) * sy };
  };

  const onPointerDown = (e: React.MouseEvent | React.TouchEvent) => {
    if (me?.id !== drawerId) return;
    e.preventDefault();
    setIsDrawing(true);
    lastPos.current = getPos(e);
  };

  const onPointerMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing || me?.id !== drawerId || !lastPos.current) return;
    e.preventDefault();
    const pos = getPos(e);
    const d: DrawData = { x0: lastPos.current.x, y0: lastPos.current.y, x1: pos.x, y1: pos.y, color: isEraser ? "#ffffff" : color, size: isEraser ? size * 3 : size };
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) drawLine(ctx, d);
    channel.publish("draw", d);
    lastPos.current = pos;
  };

  const onPointerUp = () => { setIsDrawing(false); lastPos.current = null; };

  /* ── derived ── */
  const sortedPlayers = [...players].sort((a, b) => b.score - a.score);
  const isDrawer = !!me && me.id === drawerId;
  const drawerName = players.find((p) => p.id === drawerId)?.name;
  const timerPercent = (timer / ROUND_TIME) * 100;
  const timerColor = timer > 30 ? "#2a9d8f" : timer > 10 ? "#f4a261" : "#e63946";

  /* ══════════════════════════════════════════ RENDER ══════════════════════════════════════════ */

  if (!me) {
    return (
      <div style={S.lobby}>
        <div style={S.lobbyCard}>
          <div style={S.lobbyTitle}>✏️ Scribble</div>
          <p style={S.lobbySubtitle}>Guess &amp; Draw with friends</p>
          <input style={S.input} placeholder="Your name..." value={name}
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && join()} autoFocus />
          <button style={S.btn} onClick={join}>Join Game →</button>
        </div>
        <style>{CSS}</style>
      </div>
    );
  }

  if (phase === "gameOver") {
    const winner = sortedPlayers[0];
    return (
      <div style={S.lobby}>
        <div style={{ ...S.lobbyCard, gap: 16 }}>
          <div style={S.lobbyTitle}>🏆 Game Over!</div>
          <p style={{ ...S.lobbySubtitle, color: "#f4a261" }}>{winner?.name} wins!</p>
          <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 6 }}>
            {sortedPlayers.map((p, i) => (
              <div key={p.id} style={{ display: "flex", justifyContent: "space-between", padding: "10px 14px", borderRadius: 8, background: i === 0 ? "rgba(244,162,97,0.15)" : "rgba(255,255,255,0.05)" }}>
                <span style={{ color: i === 0 ? "#f4a261" : "#aaa" }}>{(["🥇","🥈","🥉"] as string[])[i] ?? `#${i+1}`} {p.name}</span>
                <strong style={{ color: "#fff" }}>{p.score} pts</strong>
              </div>
            ))}
          </div>
          <button style={S.btn} onClick={() => { setPhase("lobby"); setRound(1); setChat([]); clearCanvas(); }}>Play Again</button>
        </div>
        <style>{CSS}</style>
      </div>
    );
  }

  if (phase === "choosing" && isDrawer && wordChoices.length > 0) {
    return (
      <div style={S.lobby}>
        <div style={S.lobbyCard}>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#fff", marginBottom: 8 }}>Choose a word to draw</div>
          {wordChoices.map((w) => (
            <button key={w} style={{ ...S.btn, width: "100%", marginBottom: 8 }} onClick={() => handleWordChoice(w)}>{w}</button>
          ))}
        </div>
        <style>{CSS}</style>
      </div>
    );
  }

  return (
    <div style={S.app}>
      {/* Header */}
      <div style={S.header}>
        <span style={S.badge}>Round {round}/{TOTAL_ROUNDS}</span>
        <div style={{ textAlign: "center" }}>
          <div style={{ ...S.timerNum, color: timerColor }}>{timer}s</div>
          <div style={S.timerBar}><div style={{ ...S.timerFill, width: `${timerPercent}%`, background: timerColor }} /></div>
        </div>
        <span style={{ fontSize: 13, color: "#aaa", textAlign: "right" as const }}>
          {drawerName ? <>✏️ <b style={{ color: "#fff" }}>{drawerName}</b></> : null}
        </span>
      </div>

      {/* Word strip */}
      <div style={S.wordStrip}>
        {!isDrawer && phase === "playing" && <span style={S.wordText}>{maskedWord || "⏳ Waiting..."}</span>}
        {!isDrawer && phase === "choosing" && <span style={{ ...S.wordText, color: "#aaa", fontSize: 14, letterSpacing: 1 }}>⏳ {drawerName} is choosing a word...</span>}
        {isDrawer && word && phase === "playing" && <span style={S.wordText}>Your word: <b style={{ color: "#f4a261" }}>{word.toUpperCase()}</b></span>}
        {roundWinner && <span style={S.winnerPill}>🎉 {roundWinner} guessed it!</span>}
      </div>

      {/* Players strip — horizontal scroll on mobile */}
      <div style={S.playersStrip}>
        {sortedPlayers.map((p, i) => (
          <div key={p.id} style={{ ...S.playerChip, background: p.id === me.id ? "rgba(42,157,143,0.25)" : "rgba(255,255,255,0.06)", border: p.id === drawerId ? "1px solid rgba(42,157,143,0.5)" : "1px solid transparent" }}>
            <span style={{ fontSize: 11, color: "#777" }}>{(["🥇","🥈","🥉"] as string[])[i] ?? `#${i+1}`}</span>
            <span style={{ fontSize: 13, fontWeight: 600, maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
              {p.name}{p.id === drawerId ? " ✏️" : ""}{p.hasGuessed ? " ✅" : ""}
            </span>
            <span style={{ fontSize: 12, color: "#f4a261", fontWeight: 700 }}>{p.score} pts</span>
          </div>
        ))}
      </div>

      {/* Canvas — full width, natural aspect ratio */}
      <div style={S.canvasWrap}>
        <canvas
          ref={canvasRef} width={600} height={450}
          style={{ ...S.canvas, cursor: isDrawer ? (isEraser ? "cell" : "crosshair") : "default" }}
          onMouseDown={onPointerDown} onMouseMove={onPointerMove} onMouseUp={onPointerUp} onMouseLeave={onPointerUp}
          onTouchStart={onPointerDown} onTouchMove={onPointerMove} onTouchEnd={onPointerUp}
        />
      </div>

      {/* Drawing toolbar */}
      {isDrawer && (
        <div style={S.toolbar}>
          <div style={S.colorRow}>
            {COLORS.map((c) => (
              <button key={c} onClick={() => { setColor(c); setIsEraser(false); }}
                style={{ ...S.colorDot, background: c, border: color === c && !isEraser ? "3px solid #fff" : "2px solid rgba(255,255,255,0.2)", transform: color === c && !isEraser ? "scale(1.3)" : "scale(1)" }} />
            ))}
            <input type="color" value={color} onChange={(e) => { setColor(e.target.value); setIsEraser(false); }} style={S.colorPicker} title="Custom colour" />
          </div>
          <div style={S.toolRow}>
            <label style={{ color: "#aaa", fontSize: 12, whiteSpace: "nowrap" as const }}>Size {size}</label>
            <input type="range" min={2} max={20} value={size} onChange={(e) => setSize(+e.target.value)} style={{ flex: 1, minWidth: 60, accentColor: "#2a9d8f" }} />
            <button style={{ ...S.toolBtn, background: isEraser ? "#e63946" : "rgba(255,255,255,0.12)" }} onClick={() => setIsEraser(!isEraser)}>⬜ Eraser</button>
            <button style={{ ...S.toolBtn, background: "rgba(255,255,255,0.12)" }} onClick={() => { channel.publish("clear", {}); clearCanvas(); }}>🗑️ Clear</button>
          </div>
        </div>
      )}

      {/* Chat panel */}
      <div style={S.chatPanel}>
        <div style={S.chatHeader}>💬 Chat</div>
        <div style={S.chatMessages}>
          {chat.length === 0 && <span style={{ color: "#555", fontSize: 13, fontStyle: "italic" }}>No messages yet…</span>}
          {chat.map((c) => (
            <div key={c.id} style={{ ...S.chatMsg, color: c.type === "correct" ? "#43aa8b" : c.type === "system" ? "#666" : "#ddd", fontStyle: c.type === "system" ? "italic" : "normal", fontSize: c.type === "system" ? 12 : 13 }}>
              {c.text}
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>
        {!isDrawer ? (
          <div style={S.guessRow}>
            <input
              style={{ ...S.input, flex: 1, padding: "9px 12px", fontSize: 14 }}
              placeholder="Type your guess & press Enter…"
              value={guess}
              onChange={(e) => setGuess(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitGuess()}
            />
            <button style={{ ...S.btn, padding: "9px 16px", fontSize: 14, flexShrink: 0 }} onClick={submitGuess}>Send</button>
          </div>
        ) : (
          <div style={{ color: "#555", fontSize: 12, fontStyle: "italic", textAlign: "center" as const, padding: "4px 0" }}>
            You are drawing — watch others guess!
          </div>
        )}
      </div>

      {/* Start button */}
      {phase === "lobby" && players.length >= 1 && (
        <button style={{ ...S.btn, padding: "14px 36px", fontSize: 16, marginBottom: 16 }} onClick={() => beginRound(1, players)}>
          Start Game ({players.length} player{players.length !== 1 ? "s" : ""})
        </button>
      )}

      <style>{CSS}</style>
    </div>
  );
}

/* ─────────────────────── styles ─────────────────────── */

const CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #fff; font-family: 'Segoe UI', system-ui, sans-serif; }
  ::-webkit-scrollbar { width: 4px; height: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }
  canvas { touch-action: none; display: block; }
  input::placeholder { color: #555; }
`;

const S: Record<string, React.CSSProperties> = {
  /* screens */
  lobby:      { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(135deg,#0d1117 0%,#161b22 100%)", padding: 16 },
  lobbyCard:  { background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 20, padding: "40px 40px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, width: "100%", maxWidth: 360, backdropFilter: "blur(12px)" },
  lobbyTitle: { fontSize: 40, fontWeight: 800, letterSpacing: -1 },
  lobbySubtitle: { color: "#888", margin: 0, fontSize: 15 },

  /* main — single column, max 720px centred */
  app: { minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "stretch", padding: "10px 12px", gap: 8, maxWidth: 720, margin: "0 auto", width: "100%" },

  /* header */
  header:    { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 14px", background: "rgba(255,255,255,0.04)", borderRadius: 12, border: "1px solid rgba(255,255,255,0.07)" },
  badge:     { background: "rgba(42,157,143,0.2)", color: "#2a9d8f", fontSize: 12, fontWeight: 700, padding: "3px 8px", borderRadius: 6 },
  timerNum:  { fontSize: 26, fontWeight: 800, lineHeight: 1, textAlign: "center" as const, transition: "color 0.5s" },
  timerBar:  { width: 100, height: 4, background: "rgba(255,255,255,0.1)", borderRadius: 4, overflow: "hidden", marginTop: 3 },
  timerFill: { height: "100%", borderRadius: 4, transition: "width 1s linear, background 0.5s" },

  /* word strip */
  wordStrip: { display: "flex", alignItems: "center", justifyContent: "center", gap: 12, flexWrap: "wrap" as const, minHeight: 36 },
  wordText:  { fontSize: 18, fontWeight: 600, letterSpacing: 3, padding: "4px 16px", background: "rgba(255,255,255,0.05)", borderRadius: 8 },
  winnerPill:{ background: "rgba(67,170,139,0.2)", border: "1px solid rgba(67,170,139,0.4)", color: "#43aa8b", padding: "4px 12px", borderRadius: 20, fontWeight: 600, fontSize: 14 },

  /* players strip */
  playersStrip: { display: "flex", gap: 8, overflowX: "auto" as const, paddingBottom: 2 },
  playerChip:   { display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 2, padding: "6px 10px", borderRadius: 10, flexShrink: 0, minWidth: 70 },

  /* canvas */
  canvasWrap: { width: "100%", borderRadius: 12, overflow: "hidden", border: "1px solid rgba(255,255,255,0.1)", background: "#fff", lineHeight: 0 },
  canvas:     { width: "100%", height: "auto" },

  /* toolbar */
  toolbar:    { background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "10px 12px", display: "flex", flexDirection: "column" as const, gap: 8 },
  colorRow:   { display: "flex", gap: 6, flexWrap: "wrap" as const, alignItems: "center" },
  colorDot:   { width: 26, height: 26, borderRadius: "50%", cursor: "pointer", transition: "transform 0.1s, border 0.1s", outline: "none", flexShrink: 0 },
  colorPicker:{ width: 26, height: 26, border: "none", background: "none", cursor: "pointer", padding: 0, flexShrink: 0 },
  toolRow:    { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" as const },
  toolBtn:    { color: "#fff", border: "none", borderRadius: 7, padding: "5px 10px", fontSize: 12, cursor: "pointer", fontWeight: 500, whiteSpace: "nowrap" as const },

  /* chat */
  chatPanel:    { background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "10px 12px", display: "flex", flexDirection: "column" as const, gap: 6 },
  chatHeader:   { fontSize: 12, fontWeight: 700, color: "#666", textTransform: "uppercase" as const, letterSpacing: 1 },
  chatMessages: { display: "flex", flexDirection: "column" as const, gap: 2, maxHeight: 200, overflowY: "auto" as const, minHeight: 60 },
  chatMsg:      { fontSize: 13, lineHeight: 1.5, padding: "2px 0", borderBottom: "1px solid rgba(255,255,255,0.04)", wordBreak: "break-word" as const },
  guessRow:     { display: "flex", gap: 6 },

  /* shared */
  input: { background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, color: "#fff", padding: "10px 14px", fontSize: 15, width: "100%", outline: "none" },
  btn:   { background: "#2a9d8f", color: "#fff", border: "none", borderRadius: 10, padding: "10px 20px", fontSize: 15, fontWeight: 600, cursor: "pointer" },
};
