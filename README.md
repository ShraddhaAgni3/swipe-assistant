# 🚀 Swipe AI Interview Assistant
##### An AI-powered interview assistant built with React + Vite + Tailwind.
###### It lets candidates take a timed technical interview in a chat interface, while recruiters can view results in a dashboard.

# ✨ Features
##### 🎤 Interviewee (Chat)
##### Upload resume (PDF/DOCX).

##### Extracts Name, Email, Phone. Missing fields are collected before starting.

###### Timed interview:

###### 6 total questions → 2 Easy (20s) + 2 Medium (60s) + 2 Hard (120s).

##### Auto-submit when time expires and moves to the next question.

###### Local question bank with scoring. If you provide an OpenAI API key, the app can generate fresh questions.

## 🧑‍💼 Interviewer (Dashboard)
##### See all candidates with score & summary.

##### Sort by score or time, and search by name/email/summary.

##### View full chat history, answers, and per-question scores.

## ⚡ Persistence
##### All progress stored in localStorage (resumes, answers, timers).

##### Refreshing or closing/re-opening restores the interview state.

##### Shows a Welcome Back modal if an interview is mid-way.

## 🛠️ Tech Stack
#### React 18 + Vite (frontend)

##### Tailwind CSS (UI styling)

##### pdfjs-dist (PDF parsing)

mammoth (DOCX parsing)

localStorage (data persistence)
