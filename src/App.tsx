import { useEffect, useRef, useState } from "react";
import * as Ably from "ably";

const ably = new Ably.Realtime({ key: "YwsqLA.4od-dw:-h2pqc1TD_dMHjdyWJgq81LfPw94Papmq9qQtexgQ6k" });
const channel = ably.channels.get("scribble-global");

const WORDS = [
  "elephant",
  "computer",
  "mountain",
  "airplane",
  "football",
  "pencil",
  "camera",
  "guitar",
  "pizza",
  "rocket",
];

const ROUND_TIME = 120; // seconds
const LETTER_REVEAL_INTERVAL = 45;
const TOTAL_ROUNDS = 5;

type Player = { id: string; name: string; score: number };
type ChatMsg = { id: string; text: string };

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

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

  const [color, setColor] = useState("#000000");
  const [size, setSize] = useState(4);
  const [drawing, setDrawing] = useState(false);

  /* ---------------- JOIN ---------------- */
  const join = () => {
    if (!name.trim()) return;
    const player = { id: crypto.randomUUID(), name, score: 0 };
    setMe(player);
    channel.publish("join", player);
  };

  /* ---------------- ABLY ---------------- */
  useEffect(() => {
    channel.subscribe((msg) => {
      const d = msg.data;

      if (msg.name === "join") {
        setPlayers((p) => (p.find((x) => x.id === d.id) ? p : [...p, d]));
      }

      if (msg.name === "state") {
        setPlayers(d.players);
        setDrawerId(d.drawerId);
        setWord(d.word);
        setMaskedWord(d.maskedWord);
        setRound(d.round);
        setTimer(d.timer);
      }

      if (msg.name === "draw") drawRemote(d);
      if (msg.name === "clear") clearCanvas();
      if (msg.name === "chat") setChat((c) => [...c, d]);
    });
  }, []);

  /* ---------------- TIMER ---------------- */
  useEffect(() => {
    if (!drawerId || !word) return;
    if (timer <= 0 && me?.id === drawerId) nextRound();

    const t = setInterval(() => {
      setTimer((x) => x - 1);
    }, 1000);

    return () => clearInterval(t);
  }, [timer, drawerId, word]);

  /* ---------------- WORD REVEAL ---------------- */
  useEffect(() => {
    if (!word) return;
    const revealed = Math.floor((ROUND_TIME - timer) / LETTER_REVEAL_INTERVAL);
    let m = word
      .split("")
      .map((c, i) => (i < revealed ? c : "_"))
      .join(" ");
    setMaskedWord(m);
  }, [timer, word]);

  /* ---------------- GAME FLOW ---------------- */
  const startRound = (r: number) => {
    const drawer = players[(r - 1) % players.length];
    const w = WORDS[Math.floor(Math.random() * WORDS.length)];

    channel.publish("state", {
      players,
      drawerId: drawer.id,
      round: r,
      word: w,
      maskedWord: "_ ".repeat(w.length),
      timer: ROUND_TIME,
    });

    clearCanvas();
    channel.publish("clear", {});
  };

  const nextRound = () => {
    if (round >= TOTAL_ROUNDS) return;
    startRound(round + 1);
  };

  /* ---------------- GUESS ---------------- */
  const submitGuess = () => {
    if (!word || !me) return;

    if (guess.toLowerCase() === word.toLowerCase()) {
      channel.publish("chat", {
        id: crypto.randomUUID(),
        text: `${me.name} guessed it right 🎉`,
      });

      setPlayers((p) =>
        p.map((x) => (x.id === me.id ? { ...x, score: x.score + 10 } : x))
      );
      nextRound();
    } else {
      channel.publish("chat", {
        id: crypto.randomUUID(),
        text: `${me.name}: ${guess}`,
      });
    }
    setGuess("");
  };

  /* ---------------- DRAWING ---------------- */
  const drawRemote = (d: any) => {
    const ctx = canvasRef.current!.getContext("2d")!;
    ctx.strokeStyle = d.color;
    ctx.lineWidth = d.size;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(d.x0, d.y0);
    ctx.lineTo(d.x1, d.y1);
    ctx.stroke();
  };

  const draw = (e: any) => {
    if (me?.id !== drawerId) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = (e.clientX || e.touches[0].clientX) - rect.left;
    const y = (e.clientY || e.touches[0].clientY) - rect.top;

    if (!drawing) {
      setDrawing(true);
      return;
    }

    channel.publish("draw", {
      x0: x - 1,
      y0: y - 1,
      x1: x,
      y1: y,
      color,
      size,
    });
  };

  const stopDraw = () => setDrawing(false);

  const clearCanvas = () => {
    const ctx = canvasRef.current!.getContext("2d")!;
    ctx.clearRect(0, 0, 1000, 1000);
  };

  /* ---------------- UI ---------------- */
  if (!me) {
    return (
      <div className="center">
        <h1>🎨 Scribble</h1>
        <input value={name} onChange={(e) => setName(e.target.value)} />
        <button onClick={join}>Join Game</button>
      </div>
    );
  }

  return (
    <div className="app">
      <h3>🎨 {players.find((p) => p.id === drawerId)?.name} is drawing</h3>
      <h2>⏱️ {timer}s</h2>
      {me.id !== drawerId && <h3>{maskedWord}</h3>}

      <canvas
        ref={canvasRef}
        width={window.innerWidth < 600 ? 300 : 500}
        height={window.innerWidth < 600 ? 300 : 500}
        onMouseMove={draw}
        onMouseUp={stopDraw}
        onTouchMove={draw}
        onTouchEnd={stopDraw}
      />

      {me.id === drawerId && (
        <div className="tools">
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          <input type="range" min="2" max="10" value={size} onChange={(e) => setSize(+e.target.value)} />
          <button onClick={() => channel.publish("clear", {})}>Clear</button>
        </div>
      )}

      <div className="chat">
        {chat.map((c) => (
          <div key={c.id}>{c.text}</div>
        ))}
        <div ref={chatEndRef} />
      </div>

      {me.id !== drawerId && (
        <div className="guess">
          <input value={guess} onChange={(e) => setGuess(e.target.value)} />
          <button onClick={submitGuess}>Send</button>
        </div>
      )}

      <style>{`
        body { margin:0; background:#6a11cb; color:white; font-family:Inter }
        .center,.app { display:flex; flex-direction:column; align-items:center; gap:8px; padding:12px }
        canvas { background:white; border-radius:12px; touch-action:none }
        .tools,.guess { display:flex; gap:8px }
        .chat { width:100%; max-height:150px; overflow:auto; background:rgba(0,0,0,.2); padding:8px; border-radius:8px }
        input,button { padding:8px; border-radius:6px; border:none }
        button { background:#ffdd57; font-weight:600 }
      `}</style>
    </div>
  );
}