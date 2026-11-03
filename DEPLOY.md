# ขึ้นเว็บด้วย Render (ฟรี) — Arch Prompt Studio

แพ็กนี้มีเฉพาะโค้ดที่ใช้ขึ้นเว็บ ไม่มี `node_modules` (Render ติดตั้งให้) และ **ไม่มี `.env`** — คีย์ทั้งหมดใส่ในหน้า Environment ของ Render เท่านั้น

## 1. GitHub (เก็บโค้ด)
1. สมัคร github.com → New repository → ตั้งชื่อ (เช่น `arch-prompt-studio`) → เลือก **Private** → Create
2. หน้า repo ที่ว่าง → "uploading an existing file" → ลากไฟล์และโฟลเดอร์ทั้งหมดที่แตกจาก zip เข้าไป (ให้ `package.json` และ `render.yaml` อยู่ชั้นนอกสุด) → Commit changes

## 2. Supabase (บัญชีผู้ใช้ + ข้อมูลคลาวด์) — ข้ามได้ถ้ายังไม่ใช้ระบบสมาชิก
1. supabase.com → New project → Region: Southeast Asia (Singapore)
2. SQL Editor → วางเนื้อหาไฟล์ `supabase/schema.sql` ทั้งไฟล์ → Run
3. Project Settings → API → จดค่า Project URL, `anon` key, `service_role` key (ความลับ)

## 3. Render (รันเว็บ)
1. render.com → สมัครด้วยบัญชี GitHub
2. New → **Blueprint** → เลือก repo นี้ → Render อ่าน `render.yaml` แล้วสร้าง Web Service แบบ Free (Singapore) ให้เอง
3. หน้าขอค่าตัวแปร: ใส่เฉพาะที่ใช้ เว้นว่างที่ยังไม่มีได้
   - วิเคราะห์ภาพ: `ANTHROPIC_API_KEY`
   - สร้างภาพฟรี: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`
   - สร้างภาพเสียเงิน: `GEMINI_API_KEY` (ต้องเปิด Billing), `OPENAI_API_KEY`
   - สมาชิก: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - เติมโทเคน: `OMISE_PUBLIC_KEY`, `OMISE_SECRET_KEY` (เริ่มด้วย Test keys)
   - `BILLING_EXEMPT_EMAILS` = อีเมลของคุณ (ใช้ Engine เสียเงินโดยไม่หักโทเคน)
4. Apply → รอ build 3–5 นาที → ได้ลิงก์ `https://arch-prompt-studio-xxxx.onrender.com`
5. นำลิงก์ไปใส่
   - Render → Environment → `APP_PUBLIC_URL` = ลิงก์นี้
   - Supabase → Authentication → URL Configuration → Site URL และ Redirect URLs = ลิงก์นี้
   - Omise → Webhooks → `<ลิงก์>/api/omise/webhook`

แก้คีย์ภายหลัง: Render → Service → Environment → Save → ระบบ deploy ใหม่ให้เอง

## 4. กันเว็บหลับ (ทางเลือก)
Render ฟรีจะหลับเมื่อไม่มีคนใช้ 15 นาที (คนแรกรอ ~30–50 วินาที)
uptimerobot.com → New monitor → HTTP(s) → URL `<ลิงก์>/api/health` → ทุก 10 นาที

## 5. ทดสอบหลังขึ้นเว็บ
- เปิดลิงก์ → หน้า Studio ต้องขึ้น, `<ลิงก์>/api/health` ต้องได้ `"ok": true`
- หน้าเรนเดอร์: Engine "FLUX.2 Klein · Cloudflare" สร้างภาพได้
- สมาชิก: สมัคร → ยืนยันอีเมล → เข้าสู่ระบบ → เติมโทเคน (โหมดทดสอบ) → "จำลองการจ่ายเงิน" → ยอดเพิ่ม

## อัปเดตเวอร์ชันใหม่
อัปไฟล์ที่แก้ขึ้น GitHub (Add file → Upload files ทับของเดิม) → Render deploy ให้อัตโนมัติ

## รันบนเครื่อง
`npm install` → คัดลอก `.env.example` เป็น `.env` แล้วใส่คีย์ → `npm run dev` → http://localhost:5173
