import React, { useEffect, useRef, useState } from 'react';
import * as Ably from 'ably';

const ably = new Ably.Realtime({
  key: 'YwsqLA.4od-dw:-h2pqc1TD_dMHjdyWJgq81LfPw94Papmq9qQtexgQ6k', // 🔴 replace this
});

const channel = ably.channels.get('pictionary-global');

const WORDS = [
  'Apple',
  'Car',
  'Guitar',
  'Mountain',
  'Laptop',
  'Pizza',
  'Tiger',
  'Rocket',
  'Castle',
  'Football',
];

const TOTAL_ROUNDS = 5;
const CANVAS_SIZE = 500;

type Player = {
  id: string;
  name: string;
  score: number;
};

type Stroke = {
  x: number;
  y: number;
  dragging: boolean;
};

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [me, setMe] = useState<Player | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [round, setRound] = useState(1);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [wordOptions, setWordOptions] = useState<string[]>([]);
  const [word, setWord] = useState<string | null>(null);
  const [guess, setGuess] = useState('');
  const [gameOver, setGameOver] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);

  /* ------------------- JOIN ------------------- */
  const joinGame = (name: string) => {
    const player: Player = {
      id: crypto.randomUUID(),
      name,
      score: 0,
    };
    setMe(player);
    channel.publish('join', player);
  };

  /* ------------------- ABLY ------------------- */
  useEffect(() => {
    channel.subscribe((msg) => {
      const data = msg.data;

      if (msg.name === 'join') {
        setPlayers((p) => (p.find((x) => x.id === data.id) ? p : [...p, data]));
      }

      if (msg.name === 'state') {
        setPlayers(data.players);
        setRound(data.round);
        setDrawerId(data.drawerId);
        setWord(data.word);
        setGameOver(data.gameOver);
      }

      if (msg.name === 'draw') {
        drawRemote(data);
      }

      if (msg.name === 'clear') {
        clearCanvas();
      }
    });

    return () => channel.unsubscribe();
  }, []);

  /* ------------------- GAME LOGIC ------------------- */
  useEffect(() => {
    if (players.length > 1 && !drawerId && me?.id === players[0].id) {
      startRound(1);
    }
  }, [players]);

  const startRound = (r: number) => {
    const drawer = players[(r - 1) % players.length];
    const options = shuffle([...WORDS]).slice(0, 5);

    channel.publish('state', {
      players,
      round: r,
      drawerId: drawer.id,
      word: null,
      gameOver: false,
    });

    if (drawer.id === me?.id) {
      setWordOptions(options);
    }

    clearCanvas();
    channel.publish('clear', {});
  };

  const selectWord = (w: string) => {
    setWord(w);
    channel.publish('state', {
      players,
      round,
      drawerId,
      word: w,
      gameOver: false,
    });
    setWordOptions([]);
  };

  const submitGuess = () => {
    if (!word || !me) return;

    if (guess.toLowerCase() === word.toLowerCase()) {
      const updated = players.map((p) =>
        p.id === me.id ? { ...p, score: p.score + 10 } : p
      );

      if (round === TOTAL_ROUNDS) {
        channel.publish('state', {
          players: updated,
          round,
          drawerId,
          word,
          gameOver: true,
        });
      } else {
        channel.publish('state', {
          players: updated,
          round: round + 1,
          drawerId: null,
          word: null,
          gameOver: false,
        });
      }
    }

    setGuess('');
  };

  /* ------------------- DRAWING ------------------- */
  const startDraw = (e: React.MouseEvent) => {
    if (me?.id !== drawerId || !word) return;
    setIsDrawing(true);
    draw(e, false);
  };

  const endDraw = () => setIsDrawing(false);

  const draw = (e: React.MouseEvent, dragging: boolean) => {
    if (!isDrawing && dragging) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const stroke = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      dragging,
    };
    drawRemote(stroke);
    channel.publish('draw', stroke);
  };

  const drawRemote = (s: Stroke) => {
    const ctx = canvasRef.current!.getContext('2d')!;
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (!s.dragging) ctx.moveTo(s.x - 1, s.y);
    else ctx.lineTo(s.x, s.y);
    ctx.stroke();
  };

  const clearCanvas = () => {
    const ctx = canvasRef.current!.getContext('2d')!;
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  };

  /* ------------------- UI ------------------- */
  if (!me) {
    return (
      <div className="center">
        <h1>🎨 Scribble Party</h1>
        <input
          placeholder="Your name"
          onKeyDown={(e) =>
            e.key === 'Enter' && joinGame(e.currentTarget.value)
          }
        />
      </div>
    );
  }

  if (gameOver) {
    const sorted = [...players].sort((a, b) => b.score - a.score);
    return (
      <div className="center">
        <h1>🏆 Winner Table</h1>
        {sorted.map((p, i) => (
          <div key={p.id}>
            {i + 1}. {p.name} — {p.score}
          </div>
        ))}
        <button onClick={() => startRound(1)}>🔁 Replay</button>
      </div>
    );
  }

  return (
    <div className="app">
      <h2>
        Round {round} / {TOTAL_ROUNDS}
      </h2>
      <h3>Drawer: {players.find((p) => p.id === drawerId)?.name}</h3>

      {me.id === drawerId && !word && (
        <div className="words">
          {wordOptions.map((w) => (
            <button key={w} onClick={() => selectWord(w)}>
              {w}
            </button>
          ))}
        </div>
      )}

      <canvas
        ref={canvasRef}
        width={CANVAS_SIZE}
        height={CANVAS_SIZE}
        onMouseDown={startDraw}
        onMouseMove={(e) => draw(e, true)}
        onMouseUp={endDraw}
        onMouseLeave={endDraw}
      />

      {me.id !== drawerId && word && (
        <div className="guess">
          <input
            value={guess}
            onChange={(e) => setGuess(e.target.value)}
            placeholder="Your guess..."
          />
          <button onClick={submitGuess}>Guess</button>
        </div>
      )}

      <div className="scores">
        {players.map((p) => (
          <div key={p.id}>
            {p.name}: {p.score}
          </div>
        ))}
      </div>

      <style>{`
        body { margin: 0; font-family: Inter, sans-serif; background: linear-gradient(135deg,#667eea,#764ba2); color: white; }
        .center { display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; gap:12px; }
        .app { padding:20px; text-align:center; }
        canvas { background:#fff; border-radius:12px; margin:16px auto; display:block; }
        input { padding:10px; border-radius:8px; border:none; }
        button { padding:10px 14px; border:none; border-radius:8px; background:#ffdd57; cursor:pointer; font-weight:600; }
        .words { display:flex; gap:8px; justify-content:center; flex-wrap:wrap; }
        .scores { margin-top:12px; }
      `}</style>
    </div>
  );
}

/* ------------------- UTIL ------------------- */
function shuffle<T>(arr: T[]) {
  return arr.sort(() => Math.random() - 0.5);
}
