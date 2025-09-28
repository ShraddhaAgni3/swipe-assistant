import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Swipe – AI‑Powered Interview Assistant (single‑file demo)
 *
 * Goals covered:
 *  - Two synced tabs: Interviewee (chat) & Interviewer (dashboard)
 *  - Resume upload (PDF/DOCX), extract Name/Email/Phone; collect missing before interview
 *  - Timed interview: 6 Qs (2 Easy 20s → 2 Medium 60s → 2 Hard 120s)
 *  - Auto advance on timeout; scoring + final summary
 *  - Persistence (localStorage) including timers; Welcome Back modal
 *  - Search/sort dashboard, view candidate details & chat history
 *
 * Notes
 *  - Parsing: Uses pdfjs-dist for PDF, mammoth for DOCX. Both load in-browser.
 *  - AI: This demo ships with an offline rules-based generator + scorer so it runs without keys.
 *         If you set window.OPENAI_API_KEY at runtime (or via an input in Settings), it will
 *         try OpenAI first and gracefully fall back to local.
 *  - Styling: Tailwind utility classes (works in Vite/CRA with Tailwind). You can swap for shadcn/ui easily.
 *  - Deploy: This file can be your src/App.jsx. See README instructions in the chat message.
 */

/************************************ Helper: Local Storage ************************************/
const LS_KEY = "swipe-ai-interview-state-v1";

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn("Failed to load state", e);
    return null;
  }
}

function saveState(state) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("Failed to save state", e);
  }
}

/************************************ PDF/DOCX Parsing ************************************/
// Lazy loaders so first render is fast.
async function parsePDF(file) {
  const pdfjsLib = await import("pdfjs-dist");
  // Ensure worker is set for pdfjs >=3
  try {
    const worker = await import("pdfjs-dist/build/pdf.worker.mjs");
    // noop – bundlers will handle
  } catch (_) {}
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(" \n ") + "\n";
  }
  return text;
}

async function parseDOCX(file) {
  const mammoth = await import("mammoth");
  const arrayBuffer = await file.arrayBuffer();
  const { value } = await mammoth.extractRawText({ arrayBuffer });
  return value;
}

/************************************ Resume Field Extraction ************************************/
const emailRe = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const phoneRe = /(\+?\d{1,3}[\s-]?)?(\(?\d{3}\)?[\s-]?)?\d{3}[\s-]?\d{4}/; // tolerant global formats

function guessNameFromText(text) {
  // Heuristics: try explicit labels first, then top lines with 2–4 capitalized tokens
  const labeled = /(?:(?:name)\s*[:|-]\s*)([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){0,3})/i.exec(text);
  if (labeled && labeled[1]) return labeled[1].trim();
  const lines = text.split(/\n|\r/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const tokens = lines[i].split(/\s+/);
    const capTokens = tokens.filter((t) => /^(?:[A-Z][a-z'.-]+)$/.test(t));
    if (capTokens.length >= 2 && capTokens.length <= 4) {
      return capTokens.join(" ");
    }
  }
  return "";
}

function extractFields(text) {
  const email = (text.match(emailRe) || [""])[0];
  const phone = (text.match(phoneRe) || [""])[0];
  const name = guessNameFromText(text);
  return { name, email, phone };
}

/************************************ Question Bank + Local AI ************************************/
const LOCAL_BANK = {
  easy: [
    {
      id: "e1",
      prompt:
        "What is the Virtual DOM in React and why is it useful? Give a brief answer.",
      keywords: ["virtual dom", "diffing", "re-render", "efficient", "reconciliation"],
    },
    {
      id: "e2",
      prompt: "Explain the purpose of package.json and node_modules in a Node/React app.",
      keywords: ["dependencies", "scripts", "version", "metadata", "npm", "yarn"],
    },
    {
      id: "e3",
      prompt: "What is a REST API? Give a concise definition and one typical HTTP verb.",
      keywords: ["resource", "stateless", "http", "get", "post", "put", "delete"],
    },
  ],
  medium: [
    {
      id: "m1",
      prompt:
        "In React, compare useState and useReducer. When would you prefer useReducer?",
      keywords: ["complex state", "multiple", "actions", "reducer", "predictable"],
    },
    {
      id: "m2",
      prompt:
        "Design an Express.js endpoint to create a new user and validate input. Mention status codes.",
      keywords: ["express", "validation", "400", "201", "schema", "middleware"],
    },
    {
      id: "m3",
      prompt:
        "Explain CORS and how you would enable it safely on a Node/Express backend.",
      keywords: ["origin", "headers", "cors", "preflight", "credentials"],
    },
  ],
  hard: [
    {
      id: "h1",
      prompt:
        "Given a React SPA with heavy lists, outline a plan to improve performance. Mention at least 3 techniques.",
      keywords: [
        "memo",
        "useMemo",
        "virtualize",
        "pagination",
        "code splitting",
        "suspense",
        "debounce",
      ],
    },
    {
      id: "h2",
      prompt:
        "Sketch a production-ready auth flow for a full-stack app (frontend + Node + DB). Include tokens and refresh strategy.",
      keywords: ["jwt", "refresh", "httpOnly", "rotate", "csrf", "oauth", "session"],
    },
    {
      id: "h3",
      prompt:
        "PostgreSQL + Node: how would you design migrations and handle long-running queries under load?",
      keywords: ["migration", "transaction", "index", "pool", "timeout", "explain", "queue"],
    },
  ],
};

const DIFFICULTY_SEQUENCE = [
  { level: "easy", time: 20 },
  { level: "easy", time: 20 },
  { level: "medium", time: 60 },
  { level: "medium", time: 60 },
  { level: "hard", time: 120 },
  { level: "hard", time: 120 },
];

function pickRandom(arr, taken = new Set()) {
  const pool = arr.filter((x) => !taken.has(x.id));
  return pool[Math.floor(Math.random() * pool.length)];
}

async function maybeLLMGenerateQuestion(role, level, askedIds) {
  // If user provided an OpenAI key on window scope, try it. Otherwise, fallback to local bank.
  const apiKey = window.OPENAI_API_KEY || localStorage.getItem("OPENAI_API_KEY") || "";
  if (!apiKey) return null; // use local
  try {
    const prompt = `Generate one ${level} difficulty interview question for a ${role} role (React/Node). Reply with ONLY the question text.`;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a concise technical interviewer." },
          { role: "user", content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 128,
      }),
    });
    if (!res.ok) throw new Error("LLM request failed");
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("No content");
    // Create a synthetic question object; keywords unknown, scoring will be length-based fallback
    return { id: `llm-${Date.now()}`, prompt: content, keywords: [] };
  } catch (e) {
    console.warn("LLM generation failed – using local question bank", e);
    return null;
  }
}

function localGenerateQuestion(level, askedIds) {
  const bank = LOCAL_BANK[level];
  return pickRandom(bank, askedIds);
}

/************************************ Scoring ************************************/
function scoreAnswer(answer, question) {
  if (!answer || !answer.trim()) return 0;
  const len = answer.trim().split(/\s+/).length;
  let score = Math.min(4, Math.floor(len / 10)); // up to 4 points for substance
  // keyword hits up to +6
  const lower = answer.toLowerCase();
  const kws = question.keywords || [];
  let hits = 0;
  for (const k of kws) if (lower.includes(k)) hits++;
  score += Math.min(6, hits);
  return Math.max(0, Math.min(10, score));
}

function summarizeCandidate(candidate) {
  const avg = candidate.questions.length
    ? Math.round(
        (candidate.questions.reduce((a, q) => a + (q.score ?? 0), 0) /
          (candidate.questions.length * 10)) *
          100
      )
    : 0;
  const strengths = [];
  const areas = [];
  const catHit = (kw) =>
    candidate.questions.some((q) => (q.answer || "").toLowerCase().includes(kw));
  if (catHit("memo") || catHit("virtualize") || catHit("performance")) strengths.push("performance-minded React");
  if (catHit("jwt") || catHit("refresh")) strengths.push("auth fundamentals");
  if (catHit("validation") || catHit("schema")) strengths.push("API validation");
  if (strengths.length === 0) strengths.push("clear communication");
  if (!catHit("index")) areas.push("DB indexing & query tuning");
  if (!catHit("cors")) areas.push("CORS & security basics");

  return `Overall ${avg}%. Strengths: ${strengths.join(", ")}. Improve: ${areas
    .slice(0, 2)
    .join(", ")}.`;
}

/************************************ Core App ************************************/
export default function App() {
  const [state, setState] = useState(() =>
    loadState() || {
      candidates: [], // list of {id, profile, questions, chatHistory, finalScore, summary, status, createdAt, updatedAt, currentIndex, currentDeadline}
      activeId: null,
      settings: { role: "Full-Stack (React/Node)", useLLM: true },
      ui: { tab: "interviewee", welcomeBack: false },
    }
  );

  useEffect(() => saveState(state), [state]);

  // Welcome back modal if there is an in-progress session
  useEffect(() => {
    const active = getActiveCandidate();
    if (active && active.status === "in_progress" && !state.ui.welcomeBack) {
      setState((s) => ({ ...s, ui: { ...s.ui, welcomeBack: true } }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setActive(id) {
    setState((s) => ({ ...s, activeId: id }));
  }

  function getActiveCandidate() {
    return state.candidates.find((c) => c.id === state.activeId) || null;
  }

  function upsertCandidate(next) {
    setState((s) => ({
      ...s,
      candidates: s.candidates.some((c) => c.id === next.id)
        ? s.candidates.map((c) => (c.id === next.id ? next : c))
        : [...s.candidates, next],
    }));
  }

  function startNewCandidate() {
    const id = crypto.randomUUID();
    const now = Date.now();
    const cand = {
      id,
      profile: { name: "", email: "", phone: "", resumeText: "" },
      questions: [],
      chatHistory: [
        { role: "system", content: "Welcome to the Swipe interview! Please upload your resume to begin.", ts: now },
      ],
      finalScore: 0,
      summary: "",
      status: "awaiting_resume", // awaiting_resume -> collecting_profile -> in_progress -> completed
      createdAt: now,
      updatedAt: now,
      currentIndex: -1,
      currentDeadline: null, // epoch ms
    };
    upsertCandidate(cand);
    setActive(id);
  }

  // ensure there is always an active session
  useEffect(() => {
    if (!state.activeId) {
      // try to find an unfinished session
      const unfinished = state.candidates.find((c) => c.status !== "completed");
      if (unfinished) setActive(unfinished.id);
      else startNewCandidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeId]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4">
          <div className="font-semibold text-lg">Swipe • AI Interview Assistant</div>
          <nav className="ml-auto flex gap-2">
            <TabButton
              active={state.ui.tab === "interviewee"}
              onClick={() => setState((s) => ({ ...s, ui: { ...s.ui, tab: "interviewee" } }))}
            >
              Interviewee
            </TabButton>
            <TabButton
              active={state.ui.tab === "interviewer"}
              onClick={() => setState((s) => ({ ...s, ui: { ...s.ui, tab: "interviewer" } }))}
            >
              Interviewer
            </TabButton>
            <Settings state={state} setState={setState} />
          </nav>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        {state.ui.tab === "interviewee" ? (
          <IntervieweePanel state={state} setState={setState} />
        ) : (
          <InterviewerPanel state={state} setState={setState} />
        )}
      </main>

      {state.ui.welcomeBack && (
        <WelcomeBackModal state={state} setState={setState} />
      )}
    </div>
  );
}

/************************************ UI Bits ************************************/
function TabButton({ active, children, onClick }) {
  return (
    <button
      onClick={onClick}
      className={
        "px-3 py-1.5 rounded-full text-sm border transition " +
        (active
          ? "bg-slate-900 text-white border-slate-900"
          : "bg-white hover:bg-slate-100 border-slate-300")
      }
    >
      {children}
    </button>
  );
}

function Settings({ state, setState }) {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState(
    () => localStorage.getItem("OPENAI_API_KEY") || ""
  );
  return (
    <>
      <button
        className="px-3 py-1.5 rounded-full text-sm border bg-white hover:bg-slate-100"
        onClick={() => setOpen(true)}
      >
        Settings
      </button>
      {open && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-lg">Settings</h3>
              <button className="text-slate-500" onClick={() => setOpen(false)}>
                ✕
              </button>
            </div>
            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-sm font-medium">Role</label>
                <select
                  value={state.settings.role}
                  onChange={(e) =>
                    setState((s) => ({
                      ...s,
                      settings: { ...s.settings, role: e.target.value },
                    }))
                  }
                  className="mt-1 w-full border rounded-lg p-2"
                >
                  <option>Full-Stack (React/Node)</option>
                  <option>Frontend (React)</option>
                  <option>Backend (Node)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium">OpenAI API Key (optional)</label>
                <input
                  type="password"
                  placeholder="sk-..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="mt-1 w-full border rounded-lg p-2"
                />
                <p className="text-xs text-slate-500 mt-1">
                  If provided, questions will be AI-generated; otherwise local questions are used.
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    className="px-3 py-1.5 rounded-lg border bg-slate-900 text-white"
                    onClick={() => {
                      localStorage.setItem("OPENAI_API_KEY", apiKey);
                      window.OPENAI_API_KEY = apiKey;
                      alert("Saved.");
                    }}
                  >
                    Save
                  </button>
                  <button
                    className="px-3 py-1.5 rounded-lg border"
                    onClick={() => {
                      setApiKey("");
                      localStorage.removeItem("OPENAI_API_KEY");
                      window.OPENAI_API_KEY = "";
                    }}
                  >
                    Clear
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/************************************ Interviewee Panel ************************************/
function IntervieweePanel({ state, setState }) {
  const candidate = state.candidates.find((c) => c.id === state.activeId);
  if (!candidate) return null;

  return (
    <div className="grid md:grid-cols-3 gap-6">
      <div className="md:col-span-2">
        <ChatWindow candidate={candidate} setState={setState} settings={state.settings} />
      </div>
      <div className="md:col-span-1">
        <ProfileCard candidate={candidate} setState={setState} />
      </div>
    </div>
  );
}

function ProfileCard({ candidate, setState }) {
  const { profile, status } = candidate;
  return (
    <div className="bg-white rounded-2xl border p-4 sticky top-20">
      <h3 className="font-semibold text-lg">Candidate Profile</h3>
      <div className="mt-3 text-sm space-y-1">
        <div><span className="text-slate-500">Name:</span> {profile.name || <em>—</em>}</div>
        <div><span className="text-slate-500">Email:</span> {profile.email || <em>—</em>}</div>
        <div><span className="text-slate-500">Phone:</span> {profile.phone || <em>—</em>}</div>
      </div>
      <div className="mt-4">
        <ResumeUploader candidate={candidate} setState={setState} />
      </div>
      <div className="mt-4 text-xs text-slate-500">
        Status: <span className="font-medium">{status.replaceAll("_", " ")}</span>
      </div>
    </div>
  );
}

function ResumeUploader({ candidate, setState }) {
  const [error, setError] = useState("");
  async function onFile(e) {
    setError("");
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.split(".").pop().toLowerCase();
    if (!['pdf', 'docx'].includes(ext)) {
      setError("Invalid file type. Please upload a PDF or DOCX.");
      return;
    }
    try {
      const text = ext === 'pdf' ? await parsePDF(file) : await parseDOCX(file);
      const fields = extractFields(text);
      const updated = {
        ...candidate,
        profile: { ...candidate.profile, ...fields, resumeText: text },
        updatedAt: Date.now(),
      };
      updated.chatHistory = [
        ...candidate.chatHistory,
        { role: 'system', content: 'Resume received. Checking required details…', ts: Date.now() },
      ];
      // If missing any field, move to collecting_profile; else ready to start
      const missing = [
        !fields.name && 'name',
        !fields.email && 'email',
        !fields.phone && 'phone',
      ].filter(Boolean);
      if (missing.length) {
        updated.status = 'collecting_profile';
        updated.chatHistory.push({
          role: 'assistant',
          content: `I couldn't find your ${missing.join(", ")}. Please provide them to continue.`,
          ts: Date.now(),
        });
      } else {
        updated.status = 'ready';
        updated.chatHistory.push({
          role: 'assistant',
          content: 'All set! Say "start" to begin the timed interview.',
          ts: Date.now(),
        });
      }
      setState((s) => ({
        ...s,
        candidates: s.candidates.map((c) => (c.id === candidate.id ? updated : c)),
      }));
    } catch (e) {
      console.error(e);
      setError("Failed to parse the file. Ensure the file is not encrypted.");
    }
  }

  return (
    <div>
      <label className="block text-sm font-medium">Upload Resume (PDF/DOCX)</label>
      <input type="file" accept=".pdf,.docx" onChange={onFile} className="mt-1 w-full text-sm" />
      {error && <div className="text-red-600 text-sm mt-1">{error}</div>}
    </div>
  );
}

function ChatWindow({ candidate, setState, settings }) {
  const [input, setInput] = useState("");
  const listRef = useRef(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [candidate.chatHistory.length]);

  // Timer ticking
  useEffect(() => {
    if (candidate.status !== "in_progress" || !candidate.currentDeadline) return;
    const id = setInterval(() => {
      const now = Date.now();
      if (candidate.currentDeadline && now >= candidate.currentDeadline) {
        // auto submit empty or existing answer
        handleSubmit("", true);
      }
    }, 250);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidate.status, candidate.currentDeadline, candidate.currentIndex]);

  function setCandidate(next) {
    setState((s) => ({
      ...s,
      candidates: s.candidates.map((c) => (c.id === candidate.id ? next : c)),
    }));
  }

  async function beginInterview() {
    const asked = new Set();
    const questions = [];
    for (let i = 0; i < DIFFICULTY_SEQUENCE.length; i++) {
      const { level, time } = DIFFICULTY_SEQUENCE[i];
      let q = null;
      if (settings.useLLM) q = await maybeLLMGenerateQuestion(settings.role, level, asked);
      if (!q) q = localGenerateQuestion(level, asked);
      asked.add(q.id);
      questions.push({ ...q, level, time, answer: "", score: null });
    }
    const now = Date.now();
    const deadline = now + questions[0].time * 1000;

    const next = {
      ...candidate,
      questions,
      status: "in_progress",
      currentIndex: 0,
      currentDeadline: deadline,
      chatHistory: [
        ...candidate.chatHistory,
        { role: "assistant", content: "Starting interview. You will get 6 questions one by one.", ts: now },
        { role: "assistant", content: `Q1 (${questions[0].level}): ${questions[0].prompt}`, ts: now },
      ],
      updatedAt: now,
    };
    setCandidate(next);
  }

  function needProfileField() {
    const { name, email, phone } = candidate.profile;
    if (!name) return "name";
    if (!email) return "email";
    if (!phone) return "phone";
    return "";
  }

  function addChat(role, content) {
    setCandidate({ ...candidate, chatHistory: [...candidate.chatHistory, { role, content, ts: Date.now() }], updatedAt: Date.now() });
  }

  async function handleSubmit(overridden, isAuto = false) {
    let text = overridden ?? input;
    if (!isAuto && !text.trim() && candidate.status === "in_progress") return;

    if (candidate.status === "awaiting_resume") {
      addChat("assistant", "Please upload your resume first to proceed.");
      setInput("");
      return;
    }

    if (candidate.status === "collecting_profile") {
      // naive routing: capture missing fields via free text
      const missing = needProfileField();
      if (missing) {
        const v = text.trim();
        let ok = false;
        if (missing === "email" && emailRe.test(v)) ok = true;
        else if (missing === "phone" && phoneRe.test(v)) ok = true;
        else if (missing === "name" && v.split(/\s+/).length >= 2) ok = true;
        if (ok) {
          const prof = { ...candidate.profile };
          prof[missing] = v;
          const ready = !needProfileField();
          const next = {
            ...candidate,
            profile: prof,
            status: ready ? "ready" : "collecting_profile",
            chatHistory: [
              ...candidate.chatHistory,
              { role: "user", content: text, ts: Date.now() },
              ready
                ? { role: "assistant", content: 'All set! Say "start" to begin.', ts: Date.now() }
                : { role: "assistant", content: `Thanks. Still missing your ${needProfileField()}.`, ts: Date.now() },
            ],
            updatedAt: Date.now(),
          };
          setCandidate(next);
          setInput("");
          return;
        } else {
          addChat("assistant", `That doesn't look like a valid ${missing}. Please try again.`);
          setInput("");
          return;
        }
      }
    }

    if (candidate.status === "ready") {
      const msg = text.trim().toLowerCase();
      setInput("");
      if (["start", "begin", "go"].some((w) => msg.includes(w))) {
        await beginInterview();
      } else {
        addChat("assistant", 'Type "start" when you are ready to begin.');
      }
      return;
    }

    if (candidate.status === "in_progress") {
      const idx = candidate.currentIndex;
      const questions = [...candidate.questions];
      const q = questions[idx];
      const now = Date.now();

      const answerText = (isAuto && !input.trim() && !overridden) ? "[No answer submitted before time]" : (overridden || input);
      const sc = scoreAnswer(answerText, q);
      questions[idx] = { ...q, answer: answerText, score: sc };

      // Move next or finish
      const nextIdx = idx + 1;
      const done = nextIdx >= questions.length;
      const history = [
        ...candidate.chatHistory,
        { role: "user", content: isAuto ? (overridden || "(auto-submitted)") : input, ts: now },
      ];
      if (done) {
        const total = questions.reduce((a, x) => a + (x.score ?? 0), 0);
        const finalScore = Math.round((total / (questions.length * 10)) * 100);
        const summary = summarizeCandidate({ ...candidate, questions });
        const next = {
          ...candidate,
          questions,
          currentIndex: nextIdx,
          currentDeadline: null,
          status: "completed",
          finalScore,
          summary,
          chatHistory: [
            ...history,
            { role: "assistant", content: `Interview finished. Final Score: ${finalScore}%.`, ts: now },
            { role: "assistant", content: `Summary: ${summary}`, ts: now },
          ],
          updatedAt: now,
        };
        setCandidate(next);
        setInput("");
      } else {
        const deadline = now + questions[nextIdx].time * 1000;
        const next = {
          ...candidate,
          questions,
          currentIndex: nextIdx,
          currentDeadline: deadline,
          chatHistory: [
            ...history,
            { role: "assistant", content: `Q${nextIdx + 1} (${questions[nextIdx].level}): ${questions[nextIdx].prompt}` , ts: now },
          ],
          updatedAt: now,
        };
        setCandidate(next);
        setInput("");
      }
      return;
    }

    // default
    setInput("");
  }

  const remainingMs = Math.max(0, (candidate.currentDeadline || 0) - Date.now());

  return (
    <div className="bg-white rounded-2xl border p-4 flex flex-col h-[70vh]">
      <div ref={listRef} className="flex-1 overflow-y-auto pr-2 space-y-3">
        {candidate.chatHistory.map((m, i) => (
          <ChatBubble key={i} role={m.role} content={m.content} ts={m.ts} />
        ))}
        {candidate.status === "in_progress" && (
          <div className="sticky bottom-0 bg-white/90 backdrop-blur mt-2 py-2">
            <ProgressBar
              current={candidate.currentIndex + 1}
              total={candidate.questions.length}
              label={`Time left: ${Math.ceil(remainingMs / 1000)}s`}
              pct={candidate.currentDeadline ? (remainingMs / (candidate.questions[candidate.currentIndex].time * 1000)) * 100 : 0}
            />
          </div>
        )}
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <input
          className="flex-1 border rounded-xl px-3 py-2"
          placeholder={
            candidate.status === "awaiting_resume"
              ? "Upload your resume to continue…"
              : candidate.status === "collecting_profile"
              ? `Please enter your ${needProfileField()}…`
              : candidate.status === "ready"
              ? 'Type "start" to begin…'
              : "Type your answer and press Enter…"
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={candidate.status === "awaiting_resume"}
        />
        <button className="px-4 py-2 rounded-xl bg-slate-900 text-white" type="submit">
          Send
        </button>
      </form>
    </div>
  );
}

function ChatBubble({ role, content, ts }) {
  const isUser = role === "user";
  const isSystem = role === "system";
  return (
    <div className={"flex " + (isUser ? "justify-end" : "justify-start") }>
      <div
        className={
          "max-w-[80%] rounded-2xl px-3 py-2 text-sm shadow " +
          (isSystem
            ? "bg-slate-100 text-slate-700"
            : isUser
            ? "bg-slate-900 text-white"
            : "bg-white border")
        }
      >
        <div className="whitespace-pre-wrap">{content}</div>
        <div className="text-[10px] mt-1 opacity-60">
          {new Date(ts).toLocaleString()}
        </div>
      </div>
    </div>
  );
}

function ProgressBar({ current, total, pct, label }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <div>Question {current}/{total}</div>
        <div>{label}</div>
      </div>
      <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
        <div className="h-full bg-slate-900" style={{ width: `${100 - Math.max(0, Math.min(100, Math.round(pct)))}%`, transition: 'width 0.2s linear' }} />
      </div>
    </div>
  );
}

/************************************ Interviewer Panel ************************************/
function InterviewerPanel({ state, setState }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("score-desc");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = state.candidates.map((c) => ({
      ...c,
      scorePct: Math.round(((c.questions.reduce((a, x) => a + (x.score ?? 0), 0)) / (c.questions.length || 1) / 10) * 100) || 0,
    }));
    if (q) {
      list = list.filter((c) =>
        [c.profile.name, c.profile.email, c.profile.phone, c.summary]
          .filter(Boolean)
          .some((s) => s.toLowerCase().includes(q))
      );
    }
    list.sort((a, b) => {
      switch (sort) {
        case "score-asc":
          return a.scorePct - b.scorePct;
        case "time-desc":
          return b.updatedAt - a.updatedAt;
        case "time-asc":
          return a.updatedAt - b.updatedAt;
        case "score-desc":
        default:
          return b.scorePct - a.scorePct;
      }
    });
    return list;
  }, [state.candidates, query, sort]);

  const [selected, setSelected] = useState(null);

  return (
    <div className="grid md:grid-cols-3 gap-6">
      <div className="md:col-span-2 bg-white rounded-2xl border p-4">
        <div className="flex gap-2 items-center">
          <input
            className="flex-1 border rounded-xl px-3 py-2"
            placeholder="Search candidates by name/email/phone/summary…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="border rounded-xl px-3 py-2"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="score-desc">Top Score</option>
            <option value="score-asc">Low Score</option>
            <option value="time-desc">Recent</option>
            <option value="time-asc">Oldest</option>
          </select>
        </div>

        <div className="mt-4 overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="py-2">Name</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Status</th>
                <th>Score</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className="border-t hover:bg-slate-50 cursor-pointer" onClick={() => setSelected(c)}>
                  <td className="py-2 font-medium">{c.profile.name || "—"}</td>
                  <td>{c.profile.email || "—"}</td>
                  <td>{c.profile.phone || "—"}</td>
                  <td className="capitalize">{c.status.replaceAll("_", " ")}</td>
                  <td>{c.scorePct}%</td>
                  <td>{new Date(c.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-slate-500">
                    No candidates yet. Start an interview from the Interviewee tab.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="md:col-span-1">
        <CandidateDetail candidate={selected} />
      </div>
    </div>
  );
}

function CandidateDetail({ candidate }) {
  if (!candidate)
    return (
      <div className="bg-white rounded-2xl border p-4 sticky top-20 text-sm text-slate-600">
        Select a candidate to view details.
      </div>
    );
  return (
    <div className="bg-white rounded-2xl border p-4 sticky top-20">
      <h3 className="font-semibold text-lg">{candidate.profile.name || "Unnamed"}</h3>
      <div className="text-sm text-slate-600">{candidate.profile.email} · {candidate.profile.phone}</div>
      <div className="mt-3 text-sm">
        <div className="font-medium">Final Summary</div>
        <div className="text-slate-700 mt-1">
          {candidate.summary || <em>— Not completed —</em>}
        </div>
      </div>
      <div className="mt-4">
        <div className="font-medium">Q&A Breakdown</div>
        <ol className="text-sm mt-2 space-y-2 list-decimal list-inside">
          {candidate.questions.map((q, idx) => (
            <li key={idx} className="border rounded-xl p-2">
              <div className="text-slate-700"><span className="uppercase text-xs tracking-wide mr-2">{q.level}</span>{q.prompt}</div>
              <div className="mt-1"><span className="text-slate-500 text-xs">Answer:</span> {q.answer || <em>—</em>}</div>
              <div className="mt-1"><span className="text-slate-500 text-xs">Score:</span> {q.score ?? "—"}/10</div>
            </li>
          ))}
          {candidate.questions.length === 0 && (
            <div className="text-slate-500">No questions yet.</div>
          )}
        </ol>
      </div>
      <div className="mt-4 text-xs text-slate-500">Updated {new Date(candidate.updatedAt).toLocaleString()}</div>
    </div>
  );
}

/************************************ Welcome Back ************************************/
function WelcomeBackModal({ state, setState }) {
  const active = state.candidates.find((c) => c.id === state.activeId);
  if (!active) return null;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-lg">Welcome back</h3>
          <button className="text-slate-500" onClick={() => setState((s) => ({ ...s, ui: { ...s.ui, welcomeBack: false } }))}>✕</button>
        </div>
        <p className="mt-2 text-sm text-slate-700">
          We restored your last session for <span className="font-medium">{active.profile.name || "this candidate"}</span>.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="px-3 py-1.5 rounded-lg border"
            onClick={() => {
              // discard session and start a new candidate
              setState((s) => ({ ...s, ui: { ...s.ui, welcomeBack: false } }));
              const id = crypto.randomUUID();
              const now = Date.now();
              const cand = {
                id,
                profile: { name: "", email: "", phone: "", resumeText: "" },
                questions: [],
                chatHistory: [
                  { role: "system", content: "Welcome to the Swipe interview! Please upload your resume to begin.", ts: now },
                ],
                finalScore: 0,
                summary: "",
                status: "awaiting_resume",
                createdAt: now,
                updatedAt: now,
                currentIndex: -1,
                currentDeadline: null,
              };
              setState((s) => ({ ...s, candidates: [...s.candidates, cand], activeId: id }));
            }}
          >
            Start New
          </button>
          <button
            className="px-3 py-1.5 rounded-lg bg-slate-900 text-white"
            onClick={() => setState((s) => ({ ...s, ui: { ...s.ui, welcomeBack: false } }))}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
