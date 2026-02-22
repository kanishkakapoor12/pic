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
  "#1a1a2e", "#e63946", "#f4a261", "#2a9d8f", "#457b9d",
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

  const [name, setName] = useState("");
  const [me, setMe] = useState<Player | null>(null);
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

  const [color, setColor] = useState("#1a1a2e");
  const [size, setSize] = useState(4);
  const [isEraser, setIsEraser] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [wordChoices, setWordChoices] = useState<string[]>([]);

  /* ── helpers ── */
  const getMasked = (w: string, elapsed: number) => {
    const revealed = Math.floor(elapsed / LETTER_REVEAL_INTERVAL);
    return w.split("").map((c, i) => (c === " " ? "/" : i < revealed ? c : "_")).join(" ");
  };

  const pickWords = () => {
    const shuffled = [...WORDS].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 3);
  };

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
    setMe(player);
    channel.publish("join", player);
  };

  /* ── ably subscription ── */
  useEffect(() => {
    channel.subscribe((msg) => {
      const d = msg.data;

      if (msg.name === "join") {
        setPlayers((p) => (p.find((x) => x.id === d.id) ? p : [...p, d]));
        addChat({ id: crypto.randomUUID(), text: `${d.name} joined the game`, type: "system" });
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
        if (ctx) drawLine(ctx, d);
      }

      if (msg.name === "clear") clearCanvas();

      if (msg.name === "chat") {
        setChat((c) => [...c, d]);
      }

      if (msg.name === "wordChoices") {
        setMe((m) => m && m.id === d.drawerId ? m : m);
        if (d.drawerId) setWordChoices(d.words);
      }
    });

    return () => { channel.unsubscribe(); };
  }, [drawLine, clearCanvas]);

  /* ── timer ── */
  useEffect(() => {
    if (phase !== "playing" || !drawerId) return;

    if (timerRef.current) clearInterval(timerRef.current);

    timerRef.current = setInterval(() => {
      setTimer((t) => {
        const next = t - 1;
        if (next <= 0) {
          if (timerRef.current) clearInterval(timerRef.current);
          return 0;
        }
        return next;
      });
    }, 1000);

    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [phase, drawerId, round]);

  /* ── word reveal ── */
  useEffect(() => {
    if (!word || phase !== "playing") return;
    setMe((m) => {
      if (!m) return m;
      if (m.id === drawerId) return m; // drawer knows the word
      const elapsed = ROUND_TIME - timer;
      setMaskedWord(getMasked(word, elapsed));
      return m;
    });
  }, [timer, word, phase, drawerId]);

  /* ── auto-scroll chat ── */
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat]);

  const addChat = (msg: ChatMsg) => setChat((c) => [...c, msg]);

  /* ── game flow ── */
  const startRound = (r: number, chosenWord: string) => {
    const drawerIndex = (r - 1) % players.length;
    const drawer = players[drawerIndex];
    if (!drawer) return;

    channel.publish("state", {
      players: players.map((p) => ({ ...p, hasGuessed: false })),
      drawerId: drawer.id,
      round: r,
      word: chosenWord,
      maskedWord: getMasked(chosenWord, 0),
      timer: ROUND_TIME,
      phase: "playing",
      roundWinner: null,
    });
    channel.publish("clear", {});
  };

  const beginRound = (r: number) => {
    const drawerIndex = (r - 1) % players.length;
    const drawer = players[drawerIndex];
    if (!drawer) return;
    const choices = pickWords();

    // publish word choices only to drawer
    channel.publish("wordChoices", { drawerId: drawer.id, words: choices });
    channel.publish("state", {
      players,
      drawerId: drawer.id,
      round: r,
      word: null,
      maskedWord: null,
      timer: ROUND_TIME,
      phase: "choosing",
      roundWinner: null,
    });
  };

  const handleWordChoice = (chosen: string) => {
    setWordChoices([]);
    startRound(round, chosen);
  };

  /* ── guess ── */
  const submitGuess = () => {
    if (!word || !me || me.id === drawerId || !guess.trim()) return;

    if (guess.trim().toLowerCase() === word.toLowerCase()) {
      const points = Math.max(10, Math.ceil((timer / ROUND_TIME) * 100));
      const updated = players.map((p) =>
        p.id === me.id ? { ...p, score: p.score + points, hasGuessed: true } : p
      );

      channel.publish("chat", {
        id: crypto.randomUUID(),
        text: `🎉 ${me.name} guessed it! (+${points} pts)`,
        type: "correct",
      });

      channel.publish("state", {
        players: updated,
        drawerId,
        round,
        word,
        maskedWord: word.split("").join(" "),
        timer,
        phase: "playing",
        roundWinner: me.name,
      });

      setPlayers(updated);

      // end round after short delay
      setTimeout(() => {
        if (round >= TOTAL_ROUNDS) {
          channel.publish("state", {
            players: updated,
            drawerId,
            round,
            word,
            maskedWord: "",
            timer: 0,
            phase: "gameOver",
            roundWinner: me.name,
          });
        } else {
          beginRound(round + 1);
        }
      }, 3000);
    } else {
      channel.publish("chat", {
        id: crypto.randomUUID(),
        text: `${me.name}: ${guess.trim()}`,
        type: "guess",
      });
    }
    setGuess("");
  };

  /* ── drawing ── */
  const getPos = (e: React.MouseEvent | React.TouchEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const scaleX = canvasRef.current!.width / rect.width;
    const scaleY = canvasRef.current!.height / rect.height;
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  };

  const onPointerDown = (e: React.MouseEvent | React.TouchEvent) => {
    if (me?.id !== drawerId) return;
    setIsDrawing(true);
    lastPos.current = getPos(e);
  };

  const onPointerMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing || me?.id !== drawerId || !lastPos.current) return;
    const pos = getPos(e);
    const d: DrawData = {
      x0: lastPos.current.x,
      y0: lastPos.current.y,
      x1: pos.x,
      y1: pos.y,
      color: isEraser ? "#ffffff" : color,
      size: isEraser ? size * 3 : size,
    };
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) drawLine(ctx, d);
    channel.publish("draw", d);
    lastPos.current = pos;
  };

  const onPointerUp = () => {
    setIsDrawing(false);
    lastPos.current = null;
  };

  const sortedPlayers = [...players].sort((a, b) => b.score - a.score);

  /* ── lobby ── */
  if (!me) {
    return (
      <div style={styles.lobby}>
        <div style={styles.lobbyCard}>
          <div style={styles.lobbyTitle}>✏️ Scribble</div>
          <p style={styles.lobbySubtitle}>Guess & Draw with friends</p>
          <input
            style={styles.input}
            placeholder="Your name..."
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && join()}
            autoFocus
          />
          <button style={styles.btn} onClick={join}>Join Game →</button>
        </div>
        <style>{globalStyles}</style>
      </div>
    );
  }

  /* ── game over ── */
  if (phase === "gameOver") {
    const winner = sortedPlayers[0];
    return (
      <div style={styles.lobby}>
        <div style={{ ...styles.lobbyCard, gap: 16 }}>
          <div style={styles.lobbyTitle}>🏆 Game Over!</div>
          <p style={{ ...styles.lobbySubtitle, color: "#f4a261" }}>{winner?.name} wins!</p>
          <div style={styles.scoreboard}>
            {sortedPlayers.map((p, i) => (
              <div key={p.id} style={{ ...styles.scoreRow, background: i === 0 ? "rgba(244,162,97,0.15)" : "rgba(255,255,255,0.05)" }}>
                <span style={{ color: i === 0 ? "#f4a261" : "#aaa" }}>{i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉"} {p.name}</span>
                <strong style={{ color: "#fff" }}>{p.score} pts</strong>
              </div>
            ))}
          </div>
          <button style={styles.btn} onClick={() => {
            setPhase("lobby");
            setRound(1);
            setChat([]);
            clearCanvas();
          }}>Play Again</button>
        </div>
        <style>{globalStyles}</style>
      </div>
    );
  }

  const isDrawer = me.id === drawerId;
  const drawerName = players.find((p) => p.id === drawerId)?.name;

  /* ── word choosing screen ── */
  if (phase === "choosing" && isDrawer && wordChoices.length > 0) {
    return (
      <div style={styles.lobby}>
        <div style={styles.lobbyCard}>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#fff", marginBottom: 8 }}>Choose a word to draw</div>
          {wordChoices.map((w) => (
            <button key={w} style={{ ...styles.btn, width: "100%", marginBottom: 8, background: "#2a9d8f" }} onClick={() => handleWordChoice(w)}>
              {w}
            </button>
          ))}
        </div>
        <style>{globalStyles}</style>
      </div>
    );
  }

  const timerPercent = (timer / ROUND_TIME) * 100;
  const timerColor = timer > 30 ? "#2a9d8f" : timer > 10 ? "#f4a261" : "#e63946";

  return (
    <div style={styles.app}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerInfo}>
          <span style={styles.badge}>Round {round}/{TOTAL_ROUNDS}</span>
          {drawerName && <span style={{ color: "#aaa", fontSize: 14 }}>🖌️ <b style={{ color: "#fff" }}>{drawerName}</b> is drawing</span>}
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ ...styles.timerNum, color: timerColor }}>{timer}s</div>
          <div style={styles.timerBar}>
            <div style={{ ...styles.timerFill, width: `${timerPercent}%`, background: timerColor }} />
          </div>
        </div>
        <div style={{ width: 120 }} />
      </div>

      {/* Word display */}
      {!isDrawer && phase === "playing" && (
        <div style={styles.wordDisplay}>{maskedWord || "Waiting..."}</div>
      )}
      {isDrawer && word && phase === "playing" && (
        <div style={styles.wordDisplay}>
          <span style={{ fontSize: 13, color: "#aaa", marginRight: 8 }}>Your word:</span>
          <b style={{ color: "#f4a261", letterSpacing: 2 }}>{word.toUpperCase()}</b>
        </div>
      )}

      {roundWinner && (
        <div style={styles.winnerBanner}>🎉 {roundWinner} guessed correctly!</div>
      )}

      {/* Main layout */}
      <div style={styles.main}>
        {/* Players sidebar */}
        <div style={styles.sidebar}>
          <div style={styles.sidebarTitle}>Players</div>
          {sortedPlayers.map((p, i) => (
            <div key={p.id} style={{ ...styles.playerRow, background: p.id === me.id ? "rgba(42,157,143,0.2)" : "transparent" }}>
              <span style={{ fontSize: 13 }}>
                {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`} {p.name}
                {p.id === drawerId && " ✏️"}
                {p.hasGuessed && " ✅"}
              </span>
              <span style={{ color: "#f4a261", fontWeight: 600 }}>{p.score}</span>
            </div>
          ))}
        </div>

        {/* Canvas area */}
        <div style={styles.canvasArea}>
          <canvas
            ref={canvasRef}
            width={600}
            height={450}
            style={styles.canvas}
            onMouseDown={onPointerDown}
            onMouseMove={onPointerMove}
            onMouseUp={onPointerUp}
            onMouseLeave={onPointerUp}
            onTouchStart={onPointerDown}
            onTouchMove={onPointerMove}
            onTouchEnd={onPointerUp}
          />

          {isDrawer && (
            <div style={styles.toolbar}>
              <div style={styles.colorPalette}>
                {COLORS.map((c) => (
                  <button
                    key={c}
                    style={{
                      ...styles.colorDot,
                      background: c,
                      border: color === c && !isEraser ? "3px solid #fff" : "2px solid rgba(255,255,255,0.2)",
                      transform: color === c && !isEraser ? "scale(1.25)" : "scale(1)",
                    }}
                    onClick={() => { setColor(c); setIsEraser(false); }}
                  />
                ))}
                <input
                  type="color"
                  value={color}
                  onChange={(e) => { setColor(e.target.value); setIsEraser(false); }}
                  style={styles.colorPicker}
                  title="Custom color"
                />
              </div>
              <div style={styles.toolRow}>
                <label style={{ color: "#aaa", fontSize: 12 }}>Size</label>
                <input
                  type="range" min={2} max={20} value={size}
                  onChange={(e) => setSize(+e.target.value)}
                  style={{ width: 80, accentColor: "#2a9d8f" }}
                />
                <span style={{ color: "#fff", fontSize: 12, width: 20 }}>{size}</span>
                <button
                  style={{ ...styles.toolBtn, background: isEraser ? "#e63946" : "rgba(255,255,255,0.1)" }}
                  onClick={() => setIsEraser(!isEraser)}
                >⬜ Eraser</button>
                <button
                  style={{ ...styles.toolBtn, background: "rgba(255,255,255,0.1)" }}
                  onClick={() => { channel.publish("clear", {}); clearCanvas(); }}
                >🗑️ Clear</button>
              </div>
            </div>
          )}
        </div>

        {/* Chat */}
        <div style={styles.chatPanel}>
          <div style={styles.sidebarTitle}>💬 Chat</div>
          <div style={styles.chatMessages}>
            {chat.map((c) => (
              <div
                key={c.id}
                style={{
                  ...styles.chatMsg,
                  color: c.type === "correct" ? "#43aa8b" : c.type === "system" ? "#888" : "#ddd",
                  fontStyle: c.type === "system" ? "italic" : "normal",
                  fontSize: c.type === "system" ? 12 : 13,
                }}
              >
                {c.text}
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          {!isDrawer && (
            <div style={styles.guessRow}>
              <input
                style={{ ...styles.input, flex: 1, padding: "8px 10px", fontSize: 13 }}
                placeholder="Type your guess..."
                value={guess}
                onChange={(e) => setGuess(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitGuess()}
              />
              <button style={{ ...styles.btn, padding: "8px 14px", fontSize: 13 }} onClick={submitGuess}>Send</button>
            </div>
          )}
        </div>
      </div>

      {/* Start button (lobby state) */}
      {phase === "lobby" && players.length >= 1 && (
        <button style={{ ...styles.btn, marginTop: 12, padding: "12px 32px", fontSize: 16 }} onClick={() => beginRound(1)}>
          Start Game ({players.length} player{players.length !== 1 ? "s" : ""})
        </button>
      )}

      <style>{globalStyles}</style>
    </div>
  );
}

const globalStyles = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; font-family: 'Segoe UI', system-ui, sans-serif; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }
  canvas { touch-action: none; }
`;

const styles: Record<string, React.CSSProperties> = {
  lobby: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "linear-gradient(135deg, #0d1117 0%, #161b22 100%)",
  },
  lobbyCard: {
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 20,
    padding: "40px 48px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
    minWidth: 340,
    backdropFilter: "blur(12px)",
  },
  lobbyTitle: {
    fontSize: 42,
    fontWeight: 800,
    color: "#fff",
    letterSpacing: -1,
  },
  lobbySubtitle: {
    color: "#888",
    margin: 0,
    fontSize: 15,
  },
  input: {
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 10,
    color: "#fff",
    padding: "10px 14px",
    fontSize: 15,
    width: "100%",
    outline: "none",
  },
  btn: {
    background: "#2a9d8f",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "10px 20px",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    transition: "opacity 0.15s",
  },
  scoreboard: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  scoreRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "10px 14px",
    borderRadius: 8,
  },
  app: {
    minHeight: "100vh",
    background: "#0d1117",
    color: "#fff",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "12px 16px",
    gap: 8,
  },
  header: {
    width: "100%",
    maxWidth: 1100,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 16px",
    background: "rgba(255,255,255,0.04)",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.07)",
  },
  headerInfo: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    width: 120,
  },
  badge: {
    background: "rgba(42,157,143,0.2)",
    color: "#2a9d8f",
    fontSize: 12,
    fontWeight: 600,
    padding: "3px 8px",
    borderRadius: 6,
    display: "inline-block",
    width: "fit-content",
  },
  timerNum: {
    fontSize: 28,
    fontWeight: 800,
    lineHeight: 1,
    textAlign: "center" as const,
    transition: "color 0.5s",
  },
  timerBar: {
    width: 120,
    height: 4,
    background: "rgba(255,255,255,0.1)",
    borderRadius: 4,
    overflow: "hidden",
    marginTop: 4,
  },
  timerFill: {
    height: "100%",
    borderRadius: 4,
    transition: "width 1s linear, background 0.5s",
  },
  wordDisplay: {
    fontSize: 20,
    fontWeight: 600,
    letterSpacing: 4,
    color: "#fff",
    padding: "6px 20px",
    background: "rgba(255,255,255,0.05)",
    borderRadius: 8,
    textAlign: "center",
  },
  winnerBanner: {
    background: "rgba(67,170,139,0.2)",
    border: "1px solid rgba(67,170,139,0.4)",
    color: "#43aa8b",
    padding: "8px 20px",
    borderRadius: 8,
    fontWeight: 600,
    fontSize: 15,
  },
  main: {
    width: "100%",
    maxWidth: 1100,
    display: "flex",
    gap: 12,
    alignItems: "flex-start",
  },
  sidebar: {
    width: 160,
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.07)",
    borderRadius: 12,
    padding: "12px 10px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
    flexShrink: 0,
  },
  sidebarTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: "#666",
    textTransform: "uppercase" as const,
    letterSpacing: 1,
    marginBottom: 4,
  },
  playerRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "6px 8px",
    borderRadius: 7,
    fontSize: 13,
  },
  canvasArea: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    alignItems: "center",
  },
  canvas: {
    background: "#ffffff",
    borderRadius: 12,
    width: "100%",
    maxWidth: 600,
    aspectRatio: "4/3",
    cursor: "crosshair",
    border: "1px solid rgba(255,255,255,0.1)",
  },
  toolbar: {
    width: "100%",
    maxWidth: 600,
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.07)",
    borderRadius: 12,
    padding: "10px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  colorPalette: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap" as const,
    alignItems: "center",
  },
  colorDot: {
    width: 26,
    height: 26,
    borderRadius: "50%",
    cursor: "pointer",
    transition: "transform 0.1s, border 0.1s",
    outline: "none",
  },
  colorPicker: {
    width: 26,
    height: 26,
    border: "none",
    background: "none",
    cursor: "pointer",
    borderRadius: "50%",
    padding: 0,
  },
  toolRow: {
    display: "flex",
    gap: 10,
    alignItems: "center",
  },
  toolBtn: {
    color: "#fff",
    border: "none",
    borderRadius: 7,
    padding: "5px 10px",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 500,
  },
  chatPanel: {
    width: 200,
    flexShrink: 0,
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.07)",
    borderRadius: 12,
    padding: "12px 10px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    height: "100%",
  },
  chatMessages: {
    flex: 1,
    overflowY: "auto" as const,
    display: "flex",
    flexDirection: "column",
    gap: 3,
    maxHeight: 340,
  },
  chatMsg: {
    fontSize: 13,
    lineHeight: 1.4,
    padding: "3px 0",
    borderBottom: "1px solid rgba(255,255,255,0.04)",
    wordBreak: "break-word" as const,
  },
  guessRow: {
    display: "flex",
    gap: 6,
    marginTop: 4,
  },
};
