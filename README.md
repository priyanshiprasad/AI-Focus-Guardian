# AI Focus Guardian

An AI-powered browser extension that automatically detects and blocks distracting websites in real time using **Groq API + Llama 3.1**, helping students stay focused during study sessions.

---

## Features

- **AI-Based URL Classification** — uses Llama 3.1 (via Groq) to classify any website as productive or distracting without any hardcoded blocklist
- **User Authentication** — register, login, email verification, forgot password, and Google OAuth
- **Personalized Whitelist** — add trusted sites that are never blocked, stored per user in MongoDB
- **Pomodoro Timer** — functional focus/break timer on the blocked page
- **DSA Challenges** — real LeetCode problems shown every time a site is blocked
- **Analytics Dashboard** — charts showing daily blocks, hourly patterns, top blocked sites, productive vs distracting ratio
- **Gamification** — earn points, badges and streaks for staying focused
- **Real-Time Popup Stats** — live block count, focus minutes, streak and whitelist manager

---

## Tech Stack

| Layer | Technology |
|---|---|
| Browser Extension | JavaScript, HTML5, CSS3, Chrome Manifest V3 |
| AI Classification | Groq API + Llama 3.1 8B Instant |
| Backend | Python, FastAPI, Uvicorn |
| Database | MongoDB Atlas (PyMongo) |
| Authentication | JWT (PyJWT) + bcrypt + Email Verification |
| Email | FastAPI-Mail + Gmail SMTP |
| Dashboard Charts | Chart.js |
| Deployment | Render (backend) |

---

## Setup and Installation

### 1. Clone the repository
```bash
git clone https://github.com/YOUR_USERNAME/AI-Focus-Guardian.git
cd AI-Focus-Guardian
```

### 2. Set up the backend
```bash
cd backend
pip install -r requirements.txt
```

### 3. Create your `.env` file
```bash
cp .env.example .env
```
Fill in your actual values:
```
GROQ_API_KEY=your_groq_api_key
MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/focus_guardian
JWT_SECRET=your_long_random_secret
MAIL_USERNAME=your_gmail@gmail.com
MAIL_PASSWORD=your_gmail_app_password
MAIL_FROM=your_gmail@gmail.com
GOOGLE_CLIENT_ID=your_google_client_id
```

### 4. Start the backend server
```bash
python -m uvicorn server:app --reload
```

### 5. Load the extension in Chrome
1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `browserExtension/` folder

---

## Getting API Keys

| Service | Where to get it |
|---|---|
| Groq API Key | [console.groq.com](https://console.groq.com) — free |
| MongoDB URI | [cloud.mongodb.com](https://cloud.mongodb.com) — free M0 cluster |
| Gmail App Password | Google Account → Security → 2-Step Verification → App Passwords |
| Google Client ID | [console.cloud.google.com](https://console.cloud.google.com) → APIs & Services → Credentials |

---

## Deployment

Backend is deployed on **Render**.

---

## Author

Priyanshi Prasad,
Pre-final Year B.Tech Student
