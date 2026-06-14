from fastapi import FastAPI, HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import resend
from pydantic import BaseModel
from pymongo import MongoClient
from datetime import datetime, timedelta
from collections import defaultdict
from google.oauth2 import id_token as google_id_token
from google.auth.transport import requests as google_requests
import httpx, os, bcrypt, jwt, secrets, pathlib
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="AI Focus Guardian API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve dashboard
DASH_DIR = pathlib.Path(__file__).parent / "dashboard"
DASH_DIR.mkdir(exist_ok=True)
app.mount("/dashboard", StaticFiles(directory=str(DASH_DIR), html=True), name="dashboard")

# ── MongoDB ──────────────────────────────────
MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017/")
client    = MongoClient(MONGO_URI)
db        = client["focus_guardian"]

users_col     = db["users"]
logs_col      = db["logs"]
whitelist_col = db["whitelist"]
gamify_col    = db["gamification"]

users_col.create_index("email", unique=True)

# ── Config ───────────────────────────────────
GROQ_API_KEY     = os.getenv("GROQ_API_KEY")
JWT_SECRET       = os.getenv("JWT_SECRET")
JWT_ALGO         = "HS256"
JWT_EXPIRY       = 30
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
security         = HTTPBearer()

# ── Mail config ───────────────────────────────
resend.api_key = os.getenv("RESEND_API_KEY", "")

# ── Badge definitions ─────────────────────────
BADGES = [
    {"id":"first_block",  "name":"First Block",   "icon":"🛡️", "desc":"Blocked your first distracting site",   "condition": lambda s: s["total_blocks"] >= 1},
    {"id":"focus_30",     "name":"30 Min Focus",  "icon":"⏱️", "desc":"Focused for 30 minutes in one day",     "condition": lambda s: s["total_focus_min"] >= 30},
    {"id":"focus_60",     "name":"1 Hour Focus",  "icon":"🕐", "desc":"Focused for 1 hour in one day",         "condition": lambda s: s["total_focus_min"] >= 60},
    {"id":"streak_3",     "name":"3 Day Streak",  "icon":"🔥", "desc":"Used Focus Guardian 3 days in a row",   "condition": lambda s: s["streak"] >= 3},
    {"id":"streak_7",     "name":"Week Warrior",  "icon":"⚡", "desc":"7 day focus streak",                    "condition": lambda s: s["streak"] >= 7},
    {"id":"block_10",     "name":"Blocker",       "icon":"🚫", "desc":"Blocked 10 distracting sites",          "condition": lambda s: s["total_blocks"] >= 10},
    {"id":"block_50",     "name":"Focus Master",  "icon":"🏆", "desc":"Blocked 50 distracting sites",          "condition": lambda s: s["total_blocks"] >= 50},
    {"id":"points_100",   "name":"Century",       "icon":"💯", "desc":"Earned 100 focus points",               "condition": lambda s: s["points"] >= 100},
    {"id":"points_500",   "name":"Elite Focuser", "icon":"💎", "desc":"Earned 500 focus points",               "condition": lambda s: s["points"] >= 500},
]

def calc_points(total_blocks, total_focus_min, streak):
    return (total_blocks * 1) + (total_focus_min // 10) + (streak * 5)

def get_gamification(user_id):
    return gamify_col.find_one({"user_id": user_id}, {"_id": 0}) or {
        "user_id": user_id, "points": 0, "streak": 0,
        "total_blocks": 0, "total_focus_min": 0,
        "badges": [], "last_active": ""
    }

def update_gamification(user_id, blocks_delta=0, focus_delta=0):
    g     = get_gamification(user_id)
    today = datetime.utcnow().strftime("%Y-%m-%d")
    last  = g.get("last_active", "")
    yesterday = (datetime.utcnow() - timedelta(days=1)).strftime("%Y-%m-%d")
    if last == yesterday:       g["streak"] = g.get("streak", 0) + 1
    elif last != today:         g["streak"] = 1 if last else g.get("streak", 0)
    g["last_active"]     = today
    g["total_blocks"]    = g.get("total_blocks", 0)    + blocks_delta
    g["total_focus_min"] = g.get("total_focus_min", 0) + focus_delta
    g["points"]          = calc_points(g["total_blocks"], g["total_focus_min"], g["streak"])
    earned = g.get("badges", [])
    for badge in BADGES:
        if badge["id"] not in earned and badge["condition"](g):
            earned.append(badge["id"])
    g["badges"] = earned
    gamify_col.update_one({"user_id": user_id}, {"$set": g}, upsert=True)
    return g

def get_level(points):
    if points < 50:    return {"name":"Beginner",    "icon":"🌱", "next":50,   "current":points}
    if points < 200:   return {"name":"Focused",     "icon":"📚", "next":200,  "current":points}
    if points < 500:   return {"name":"Dedicated",   "icon":"💪", "next":500,  "current":points}
    if points < 1000:  return {"name":"Scholar",     "icon":"🎓", "next":1000, "current":points}
    if points < 2000:  return {"name":"Expert",      "icon":"⚡", "next":2000, "current":points}
    return                    {"name":"Focus Master","icon":"🏆", "next":None, "current":points}

# ── MODELS ───────────────────────────────────
class RegisterRequest(BaseModel):
    name: str; email: str; password: str

class LoginRequest(BaseModel):
    email: str; password: str

class GoogleLoginRequest(BaseModel):
    id_token_str: str

class ClassifyRequest(BaseModel):
    domain: str

class LogEntry(BaseModel):
    session_id: str; domain: str; duration: int
    timestamp: int; hour: int; day_of_week: int; is_distracting: int

class FocusUpdate(BaseModel):
    focus_minutes: int

class WhitelistAddRequest(BaseModel):
    domain: str

class WhitelistRemoveRequest(BaseModel):
    domain: str

class ForgotPasswordRequest(BaseModel):
    email: str

class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str

# ── JWT ───────────────────────────────────────
def create_token(user_id, email):
    return jwt.encode(
        {"sub": user_id, "email": email,
         "exp": datetime.utcnow() + timedelta(days=JWT_EXPIRY)},
        JWT_SECRET, algorithm=JWT_ALGO)

def verify_token(credentials: HTTPAuthorizationCredentials = Depends(security)):
    try:
        return jwt.decode(credentials.credentials, JWT_SECRET, algorithms=[JWT_ALGO])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired. Please login again.")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token. Please login again.")

# ── EMAIL HELPER ──────────────────────────────
async def send_verification_email(email: str, name: str, token: str):
    verify_link = f"https://ai-focus-guardian-backend.onrender.com/api/auth/verify?token={token}"
    resend.Emails.send({
        "from": "onboarding@resend.dev",
        "to": priyanshi210325@gmail.com,
        "subject": "Verify your AI Focus Guardian account",
        "html": f"<p>Hi {name},</p><p>Click <a href='{verify_link}'>here</a> to verify your account.</p>"
    })

# ── PASSWORD RESET EMAIL HELPER ──────────────
async def send_password_reset_email(email: str, name: str, token: str):
    reset_link = f"https://ai-focus-guardian-backend.onrender.com/api/auth/reset-password?token={token}"
    resend.Emails.send({
        "from": "onboarding@resend.dev",
        "to": email,
        "subject": "Reset your AI Focus Guardian password",
        "html": f"<p>Hi {name},</p><p>Click <a href='{reset_link}'>here</a> to reset your password. Link expires in 1 hour.</p>"
    })
# ── ROOT ──────────────────────────────────────
@app.get("/")
def root():
    return {"message": "AI Focus Guardian API Running ✅",
            "dashboard": "https://ai-focus-guardian-backend.onrender.com/dashboard"}

# ── REGISTER ──────────────────────────────────
@app.post("/api/auth/register")
async def register(req: RegisterRequest):
    if users_col.find_one({"email": req.email.lower()}):
        raise HTTPException(status_code=400, detail="Email already registered.")

    hashed       = bcrypt.hashpw(req.password.encode(), bcrypt.gensalt()).decode()
    verify_token_val = secrets.token_urlsafe(32)

    result = users_col.insert_one({
        "name":          req.name.strip(),
        "email":         req.email.lower().strip(),
        "password":      hashed,
        "is_verified":   False,            # must verify email before login
        "verify_token":  verify_token_val,
        "auth_type":     "email",
        "created_at":    datetime.utcnow().isoformat()
    })
    user_id = str(result.inserted_id)
    update_gamification(user_id)

    # Send verification email
    await send_verification_email(req.email.lower(), req.name.strip(), verify_token_val)

    return {
        "message": "Registration successful! Please check your email and click the verification link before logging in.",
        "email_sent": bool(fm)
    }

# ── VERIFY EMAIL ──────────────────────────────
@app.get("/api/auth/verify")
def verify_email(token: str):
    user = users_col.find_one({"verify_token": token})
    if not user:
        raise HTTPException(status_code=400, detail="Invalid or expired verification link.")

    users_col.update_one(
        {"verify_token": token},
        {"$set":   {"is_verified": True},
         "$unset": {"verify_token": ""}}
    )
    # Return a nice HTML page instead of plain JSON
    return __import__('fastapi').responses.HTMLResponse(content="""
    <!DOCTYPE html>
    <html>
    <head>
      <title>Email Verified — AI Focus Guardian</title>
      <style>
        body{font-family:sans-serif;background:#0a0a0f;color:#e8e8f0;display:flex;
             align-items:center;justify-content:center;min-height:100vh;margin:0;}
        .card{background:#13131a;border:1px solid #1e1e2e;border-radius:16px;
              padding:40px;text-align:center;max-width:400px;}
        .icon{font-size:48px;margin-bottom:16px;}
        h1{color:#00d4aa;font-size:22px;margin-bottom:8px;}
        p{color:#8888a8;font-size:14px;line-height:1.6;}
      </style>
    </head>
    <body>
      <div class="card">
        <div class="icon">✅</div>
        <h1>Email Verified!</h1>
        <p>Your AI Focus Guardian account has been verified successfully.<br><br>
           You can now close this tab and <strong>login through the extension</strong>.</p>
      </div>
    </body>
    </html>
    """, status_code=200)

# ── LOGIN ──────────────────────────────────────
@app.post("/api/auth/login")
def login(req: LoginRequest):
    user = users_col.find_one({"email": req.email.lower()})
    if not user or not bcrypt.checkpw(req.password.encode(), user["password"].encode()):
        raise HTTPException(status_code=401, detail="Invalid email or password.")

    # Block unverified users
    if not user.get("is_verified", False):
        raise HTTPException(
            status_code=403,
            detail="Please verify your email first. Check your inbox for the verification link."
        )

    user_id = str(user["_id"])
    update_gamification(user_id)
    return {
        "message": "Login successful",
        "token":   create_token(user_id, req.email.lower()),
        "user":    {"id": user_id, "name": user["name"], "email": user["email"]}
    }

# ── RESEND VERIFICATION EMAIL ─────────────────
@app.post("/api/auth/resend-verification")
async def resend_verification(req: LoginRequest):
    user = users_col.find_one({"email": req.email.lower()})
    if not user:
        raise HTTPException(status_code=404, detail="Email not registered.")
    if user.get("is_verified"):
        raise HTTPException(status_code=400, detail="Email already verified.")

    new_token = secrets.token_urlsafe(32)
    users_col.update_one({"email": req.email.lower()},
                          {"$set": {"verify_token": new_token}})
    await send_verification_email(req.email.lower(), user["name"], new_token)
    return {"message": "Verification email resent. Please check your inbox."}

# ── FORGOT PASSWORD ───────────────────────────
@app.post("/api/auth/forgot-password")
async def forgot_password(req: ForgotPasswordRequest):
    user = users_col.find_one({"email": req.email.lower()})
    # Always return success to avoid revealing whether email is registered
    if not user:
        return {"message": "If that email is registered, a reset link has been sent."}

    if user.get("auth_type") == "google":
        raise HTTPException(
            status_code=400,
            detail="This account uses Google Sign-In. Please sign in with Google instead."
        )

    reset_token = secrets.token_urlsafe(32)
    expires_at  = (datetime.utcnow() + timedelta(hours=1)).isoformat()

    users_col.update_one(
        {"email": req.email.lower()},
        {"$set": {"reset_token": reset_token, "reset_token_expires": expires_at}}
    )
    await send_password_reset_email(req.email.lower(), user["name"], reset_token)
    return {"message": "If that email is registered, a reset link has been sent."}

# ── RESET PASSWORD PAGE (browser link from email) ──
@app.get("/api/auth/reset-password-page")
def reset_password_page(token: str):
    return __import__('fastapi').responses.HTMLResponse(content=f"""
    <!DOCTYPE html>
    <html>
    <head>
      <title>Reset Password — AI Focus Guardian</title>
      <style>
        *{{margin:0;padding:0;box-sizing:border-box;}}
        body{{font-family:'Segoe UI',sans-serif;background:#0a0a0f;color:#e8e8f0;
             display:flex;align-items:center;justify-content:center;min-height:100vh;}}
        .card{{background:#13131a;border:1px solid #1e1e2e;border-radius:20px;
               padding:36px;width:380px;}}
        h1{{font-size:20px;font-weight:800;margin-bottom:6px;color:#00d4aa;}}
        p{{font-size:13px;color:#8888a8;margin-bottom:24px;}}
        label{{display:block;font-size:11px;color:#8888a8;text-transform:uppercase;
               letter-spacing:1px;margin-bottom:5px;}}
        input{{width:100%;background:#0a0a0f;border:1px solid #1e1e2e;border-radius:8px;
               padding:10px 14px;color:#e8e8f0;font-size:13px;outline:none;
               margin-bottom:14px;transition:border-color .2s;}}
        input:focus{{border-color:#00d4aa;}}
        button{{width:100%;padding:12px;border-radius:10px;border:none;
                background:#00d4aa;color:#0a0a0f;font-size:14px;font-weight:800;
                cursor:pointer;transition:all .2s;}}
        button:hover{{transform:translateY(-1px);box-shadow:0 4px 20px rgba(0,212,170,.3);}}
        button:disabled{{opacity:.6;cursor:not-allowed;transform:none;}}
        .msg{{border-radius:8px;padding:10px 14px;font-size:12px;margin-bottom:14px;
              display:none;}}
        .msg.error{{background:rgba(255,77,109,.1);border:1px solid rgba(255,77,109,.3);
                    color:#ff4d6d;display:block;}}
        .msg.success{{background:rgba(0,212,170,.1);border:1px solid rgba(0,212,170,.3);
                      color:#00d4aa;display:block;}}
        .logo{{display:flex;align-items:center;gap:10px;margin-bottom:24px;}}
        .logo-icon{{width:40px;height:40px;background:rgba(255,77,109,.15);
                    border:1px solid rgba(255,77,109,.3);border-radius:10px;
                    display:flex;align-items:center;justify-content:center;font-size:18px;}}
      </style>
    </head>
    <body>
      <div class="card">
        <div class="logo">
          <div class="logo-icon">🛡️</div>
          <div>
            <div style="font-size:16px;font-weight:800;">Focus Guardian</div>
            <div style="font-size:10px;color:#5a5a7a;text-transform:uppercase;letter-spacing:1px;">Reset Password</div>
          </div>
        </div>
        <h1>Set New Password</h1>
        <p>Enter your new password below. Make it at least 6 characters.</p>
        <div class="msg" id="msg"></div>
        <label>New Password</label>
        <input type="password" id="pw1" placeholder="Min 6 characters"/>
        <label>Confirm Password</label>
        <input type="password" id="pw2" placeholder="Repeat your password"/>
        <button id="btn" onclick="doReset()">Reset Password</button>
      </div>
      <script>
        async function doReset() {{
          const pw1 = document.getElementById('pw1').value;
          const pw2 = document.getElementById('pw2').value;
          const msg = document.getElementById('msg');
          const btn = document.getElementById('btn');
          msg.className = 'msg';
          if (!pw1 || pw1.length < 6) {{
            msg.textContent = 'Password must be at least 6 characters.';
            msg.className = 'msg error'; return;
          }}
          if (pw1 !== pw2) {{
            msg.textContent = 'Passwords do not match.';
            msg.className = 'msg error'; return;
          }}
          btn.disabled = true; btn.textContent = 'Resetting...';
          try {{
            const res = await fetch('/api/auth/reset-password', {{
              method: 'POST',
              headers: {{'Content-Type': 'application/json'}},
              body: JSON.stringify({{ token: '{token}', new_password: pw1 }})
            }});
            const data = await res.json();
            if (!res.ok) {{
              msg.textContent = data.detail || 'Reset failed.';
              msg.className = 'msg error';
              btn.disabled = false; btn.textContent = 'Reset Password';
            }} else {{
              msg.textContent = '✅ Password reset! You can now log in with your new password.';
              msg.className = 'msg success';
              btn.style.display = 'none';
              document.getElementById('pw1').style.display = 'none';
              document.getElementById('pw2').style.display = 'none';
              document.querySelectorAll('label').forEach(l => l.style.display = 'none');
            }}
          }} catch(e) {{
            msg.textContent = 'Network error. Please try again.';
            msg.className = 'msg error';
            btn.disabled = false; btn.textContent = 'Reset Password';
          }}
        }}
      </script>
    </body>
    </html>
    """, status_code=200)

# ── RESET PASSWORD (API call from the page above) ──
@app.post("/api/auth/reset-password")
def reset_password(req: ResetPasswordRequest):
    user = users_col.find_one({"reset_token": req.token})
    if not user:
        raise HTTPException(status_code=400, detail="Invalid or expired reset link. Please request a new one.")

    expires_at = user.get("reset_token_expires", "")
    if expires_at and datetime.utcnow() > datetime.fromisoformat(expires_at):
        users_col.update_one({"reset_token": req.token},
                              {"$unset": {"reset_token": "", "reset_token_expires": ""}})
        raise HTTPException(status_code=400, detail="Reset link has expired. Please request a new one.")

    if len(req.new_password) < 6:
        raise HTTPException(status_code=422, detail="Password must be at least 6 characters.")

    hashed = bcrypt.hashpw(req.new_password.encode(), bcrypt.gensalt()).decode()
    users_col.update_one(
        {"reset_token": req.token},
        {"$set":   {"password": hashed},
         "$unset": {"reset_token": "", "reset_token_expires": ""}}
    )
    return {"message": "Password reset successfully."}


def google_login(req: GoogleLoginRequest):
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=500, detail="Google OAuth not configured.")
    try:
        id_info = google_id_token.verify_oauth2_token(
            req.id_token_str,
            google_requests.Request(),
            GOOGLE_CLIENT_ID
        )
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Invalid Google token: {str(e)}")

    email = id_info["email"].lower()
    name  = id_info.get("name", email.split("@")[0])

    # Create user if doesn't exist, else log them in
    user = users_col.find_one({"email": email})
    if not user:
        result = users_col.insert_one({
            "name":        name,
            "email":       email,
            "password":    "",
            "is_verified": True,      # Google already verified the email
            "auth_type":   "google",
            "created_at":  datetime.utcnow().isoformat()
        })
        user_id = str(result.inserted_id)
        update_gamification(user_id)
    else:
        user_id = str(user["_id"])
        update_gamification(user_id)

    return {
        "message": "Google login successful",
        "token":   create_token(user_id, email),
        "user":    {"id": user_id, "name": name, "email": email}
    }

# ── PROFILE ───────────────────────────────────
@app.get("/api/auth/me")
def get_profile(payload: dict = Depends(verify_token)):
    from bson import ObjectId
    user = users_col.find_one({"_id": ObjectId(payload["sub"])}, {"_id": 0, "password": 0})
    if not user: raise HTTPException(status_code=404, detail="User not found.")
    return {"user": user}

# ── CLASSIFY ──────────────────────────────────
@app.post("/api/classify")
async def classify_domain(req: ClassifyRequest, payload: dict = Depends(verify_token)):
    user_id = payload["sub"]
    if whitelist_col.find_one({"user_id": user_id, "domain": req.domain}):
        return {"verdict": "ALLOW", "domain": req.domain, "source": "whitelist"}
    if not GROQ_API_KEY:
        return {"verdict": "ALLOW", "error": "GROQ_API_KEY not set"}
    async with httpx.AsyncClient() as http:
        r = await http.post("https://api.groq.com/openai/v1/chat/completions",
            headers={"Content-Type":"application/json","Authorization":f"Bearer {GROQ_API_KEY}"},
            json={"model":"llama-3.1-8b-instant","max_tokens":5,"temperature":0,
                  "messages":[
                      {"role":"system","content":"You are a URL classifier for a student focus browser extension. Given a website domain, reply with exactly one word only. Reply 'BLOCK' if the site is distracting: social media, entertainment, gaming, videos, memes, news, shopping, dating, etc. Reply 'ALLOW' if productive for studying: coding, documentation, academic, research, e-learning, developer tools, AI assistants like chatgpt.com, gemini.google.com, claude.ai, etc. No explanations. Just one word: BLOCK or ALLOW."},
                      {"role":"user","content":req.domain}]},
            timeout=10.0)
    if r.status_code != 200:
        return {"verdict": "ALLOW", "error": f"Groq error {r.status_code}"}
    verdict = r.json()["choices"][0]["message"]["content"].strip().upper()
    verdict = verdict if verdict in ("BLOCK","ALLOW") else "ALLOW"
    return {"verdict": verdict, "domain": req.domain, "source": "ai"}

# ── LOGS ──────────────────────────────────────
@app.post("/api/logs")
def receive_log(log: LogEntry, payload: dict = Depends(verify_token)):
    user_id = payload["sub"]
    logs_col.insert_one({**log.dict(), "user_id": user_id,
                          "created_at": datetime.utcnow().isoformat()})
    if log.is_distracting:
        update_gamification(user_id, blocks_delta=1)
    return {"status": "saved"}

@app.get("/api/logs")
def get_logs(payload: dict = Depends(verify_token)):
    logs = list(logs_col.find({"user_id": payload["sub"]}, {"_id": 0}))
    return {"total_logs": len(logs), "logs": logs}

# ── FOCUS UPDATE ──────────────────────────────
@app.post("/api/focus")
def update_focus(req: FocusUpdate, payload: dict = Depends(verify_token)):
    g = update_gamification(payload["sub"], focus_delta=req.focus_minutes)
    return {"status": "updated", "points": g["points"], "streak": g["streak"]}

# ── ANALYTICS ─────────────────────────────────
@app.get("/api/analytics")
def get_analytics(payload: dict = Depends(verify_token)):
    user_id = payload["sub"]
    logs    = list(logs_col.find({"user_id": user_id}, {"_id": 0}))

    daily = defaultdict(int)
    for log in logs:
        if log.get("is_distracting"):
            day = datetime.fromtimestamp(log["timestamp"]).strftime("%Y-%m-%d")
            daily[day] += 1

    last7 = []
    for i in range(6, -1, -1):
        d = (datetime.utcnow() - timedelta(days=i)).strftime("%Y-%m-%d")
        last7.append({"date": d, "blocks": daily.get(d, 0)})

    hourly = defaultdict(int)
    for log in logs:
        if log.get("is_distracting"):
            hourly[log.get("hour", 0)] += 1
    hourly_data = [{"hour": h, "blocks": hourly.get(h, 0)} for h in range(24)]

    domain_count = defaultdict(int)
    for log in logs:
        if log.get("is_distracting"):
            domain_count[log["domain"]] += 1
    top_domains = sorted([{"domain": k, "count": v} for k, v in domain_count.items()],
                          key=lambda x: x["count"], reverse=True)[:8]

    g = get_gamification(user_id)
    return {
        "daily_blocks":   last7,
        "hourly_pattern": hourly_data,
        "top_domains":    top_domains,
        "summary": {
            "total_blocks":    g.get("total_blocks", 0),
            "total_focus_min": g.get("total_focus_min", 0),
            "streak":          g.get("streak", 0),
            "points":          g.get("points", 0),
            "total_logs":      len(logs)
        }
    }

# ── GAMIFICATION ──────────────────────────────
@app.get("/api/gamification")
def get_gamification_data(payload: dict = Depends(verify_token)):
    g = get_gamification(payload["sub"])
    all_badges = [{"id": b["id"], "name": b["name"], "icon": b["icon"],
                   "desc": b["desc"], "earned": b["id"] in g.get("badges", [])}
                  for b in BADGES]
    return {
        "points":          g.get("points", 0),
        "streak":          g.get("streak", 0),
        "total_blocks":    g.get("total_blocks", 0),
        "total_focus_min": g.get("total_focus_min", 0),
        "badges":          all_badges,
        "level":           get_level(g.get("points", 0))
    }

# ── WHITELIST ─────────────────────────────────
@app.get("/api/whitelist")
def get_whitelist(payload: dict = Depends(verify_token)):
    entries = list(whitelist_col.find({"user_id": payload["sub"]}, {"_id": 0, "domain": 1}))
    domains = [e["domain"] for e in entries]
    for d in ["chatgpt.com","claude.ai","gemini.google.com","github.com"]:
        if d not in domains: domains.append(d)
    return {"whitelist": domains}

@app.post("/api/whitelist")
def add_whitelist(req: WhitelistAddRequest, payload: dict = Depends(verify_token)):
    whitelist_col.update_one(
        {"user_id": payload["sub"], "domain": req.domain},
        {"$set": {"user_id": payload["sub"], "domain": req.domain,
                  "added_at": datetime.utcnow().isoformat()}},
        upsert=True)
    return {"status": "added", "domain": req.domain}

@app.delete("/api/whitelist")
def remove_whitelist(req: WhitelistRemoveRequest, payload: dict = Depends(verify_token)):
    result = whitelist_col.delete_one({"user_id": payload["sub"], "domain": req.domain})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Domain not found.")
    return {"status": "removed", "domain": req.domain}
