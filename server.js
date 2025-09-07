// server.js
import express from "express";
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 5000;
app.use(express.static("public"));

// ================== BROWSER SINGLETON ==================
let browser;
async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox", 
        "--disable-setuid-sandbox", 
        "--disable-dev-shm-usage",
        "--disable-web-security",
        "--disable-features=VizDisplayCompositor"
      ],
    });
    console.log("✅ Chromium started");
  }
  return browser;
}

// ================== CACHE ==================
let footballCache = null;
let footballCacheTime = 0;
let volleyballCache = null;
let volleyballCacheTime = 0;

// ================== COMMON HEADERS ==================
const getCommonHeaders = (referer = null) => ({
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "*/*",
  "Accept-Language": "th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "cross-site",
  "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  ...(referer && { "Referer": referer }),
});

// ================== SCRAPE FOOTBALL ==================
async function scrapeFootballList() {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    // Set extra headers
    await page.setExtraHTTPHeaders(getCommonHeaders());
    
    await page.goto("https://doofootball.vip/new-doofootball-vip-2025/", {
      waitUntil: "networkidle",
      timeout: 30000,
    });
    await page.waitForSelector("div.row.gy-3", { timeout: 15000 });

    const results = await page.evaluate(() => {
      const matches = [];
      const rows = document.querySelectorAll("div.row.gy-3");
      rows.forEach((row) => {
        try {
          const timeCols = row.querySelectorAll("div.col-lg-1");
          timeCols.forEach((timeCol) => {
            const hasLive = timeCol.querySelector(
              'img[src="https://api-soccer.thai-play.com/images/live.gif"]'
            );
            // if (!hasLive) return; 
            //บรรทัดบนถ้าไม่สน

            const time = timeCol.innerText.replace(/\s+/g, " ").trim().replace("LIVE", "").trim();
            const teamCol = timeCol.nextElementSibling;
            if (!teamCol) return;

            const homeTeam = teamCol.querySelector("div.text-end p")?.innerText.trim() || "";
            const score = teamCol.querySelector("div.col-lg-2 p")?.innerText.trim() || "";
            const awayTeam = teamCol.querySelector("div.text-start p")?.innerText.trim() || "";

            const tvBlock = teamCol.nextElementSibling;
            const tvImages = tvBlock ? tvBlock.querySelectorAll("img.iam-list-tv") : [];
            const tvs = Array.from(tvImages)
              .map((img) => ({
                img: img.getAttribute("src"),
                alt: img.getAttribute("alt") || "",
                dataUrl: img.getAttribute("data-url"),
              }))
              .filter((tv) => tv.dataUrl);

            if (homeTeam && awayTeam && score && tvs.length > 0) {
              matches.push({ time, homeTeam, awayTeam, score, streams: tvs });
            }
          });
        } catch (_) {}
      });
      return matches;
    });

    return results;
  } finally {
    await page.close();
  }
}

// ================== SCRAPE VOLLEYBALL ==================
async function scrapeVolleyballList() {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setExtraHTTPHeaders(getCommonHeaders());
    
    await page.goto("https://pixielive.vip/volleyball-women-world-championship-2025/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const results = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll("div.pls-card"));
      return cards
        .map((card) => {
          const live = card.querySelector("span.pls-status.live");
          const btn = card.querySelector("button.pls-btn");
          if (live && btn) {
            return { match: btn.getAttribute("aria-label"), src: btn.getAttribute("data-src") };
          }
          return null;
        })
        .filter(Boolean);
    });

    return results;
  } finally {
    await page.close();
  }
}

// ================== API ==================

// Football list (cache 60s)
app.get("/api/football", async (req, res) => {
  try {
    if (Date.now() - footballCacheTime < 60000 && footballCache) {
      return res.json(footballCache);
    }
    console.log("Scraping football matches...");
    const matches = await scrapeFootballList();
    footballCache = { success: true, data: matches, count: matches.length };
    footballCacheTime = Date.now();
    res.json(footballCache);
  } catch (err) {
    console.error("Error scraping matches:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Football stream proxy (.m3u8 & .ts)
app.get("/api/football/stream", async (req, res) => {
  const streamUrl = req.query.url;
  if (!streamUrl) return res.status(400).json({ success: false, error: "Missing url parameter" });

  try {
    const headers = getCommonHeaders("https://doofootball.vip/");
    
    // เพิ่ม Range header ถ้ามี
    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    // ลอง fetch หลายครั้ง
    let response;
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
      try {
        response = await fetch(streamUrl, { 
          headers, 
          redirect: "follow",
          timeout: 15000 
        });
        
        if (response.ok) break;
        
        if (response.status === 403) {
          // ลอง delay แล้ว retry
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempts + 1)));
        }
        
        attempts++;
      } catch (fetchErr) {
        attempts++;
        if (attempts >= maxAttempts) throw fetchErr;
        await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
      }
    }

    if (!response || !response.ok) {
      throw new Error(`HTTP ${response?.status || 'TIMEOUT'}: ${response?.statusText || 'Request failed'}`);
    }

    const contentType = response.headers.get("content-type") || "application/vnd.apple.mpegurl";

    if (streamUrl.includes(".m3u8") || contentType.includes("mpegurl")) {
      const text = await response.text();
      const baseUrl = streamUrl.substring(0, streamUrl.lastIndexOf("/") + 1);
      const modified = text.replace(/^(?!#)(?!https?:\/\/)([^\r\n]+)$/gm, (line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        const absolute = baseUrl + trimmed;
        return `/api/football/stream?url=${encodeURIComponent(absolute)}`;
      });
      
      res.set({
        "Content-Type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });
      res.send(modified);
    } else {
      // สำหรับ .ts files
      res.set({
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*", 
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Accept-Ranges": "bytes",
      });
      
      if (response.body) {
        response.body.pipe(res);
      } else {
        const buffer = await response.buffer();
        res.send(buffer);
      }
    }
  } catch (err) {
    console.error("Error proxying football stream:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Volleyball
app.get("/api/live/volleyball", async (_req, res) => {
  try {
    if (Date.now() - volleyballCacheTime < 60000 && volleyballCache) {
      return res.json(volleyballCache);
    }
    console.log("Scraping volleyball matches...");
    const data = await scrapeVolleyballList();
    volleyballCache = data;
    volleyballCacheTime = Date.now();
    res.json(data);
  } catch (err) {
    console.error("❌ Scraper Error:", err);
    res.status(500).json({ error: err.toString() });
  }
});

// TV list
app.get("/api/tv", (_req, res) => {
  try {
    const tvDataPath = path.join(process.cwd(), "tv.json");
    const raw = fs.readFileSync(tvDataPath, "utf-8");
    res.json(JSON.parse(raw));
  } catch {
    res.status(500).json({ error: "ไม่สามารถโหลดช่องทีวีได้" });
  }
});

// TV stream proxy
app.get("/api/tv/stream", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ success: false, error: "Missing url parameter" });

  try {
    const headers = getCommonHeaders("https://www.dooballfree24hrs.com/");
    
    const response = await fetch(targetUrl, {
      headers,
      redirect: "follow",
      timeout: 15000
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/vnd.apple.mpegurl") || targetUrl.endsWith(".m3u8")) {
      let playlist = await response.text();
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
      playlist = playlist.replace(/(.*\.ts.*)/g, (m) => {
        const segmentUrl = m.startsWith("http") ? m : baseUrl + m;
        return `/api/tv/stream?url=${encodeURIComponent(segmentUrl)}`;
      });
      res.set({
        "Content-Type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*"
      });
      res.send(playlist);
    } else {
      res.set({
        "Content-Type": contentType || "application/octet-stream",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*"
      });
      
      if (response.body) {
        response.body.pipe(res);
      } else {
        const buffer = await response.buffer();
        res.send(buffer);
      }
    }
  } catch (err) {
    console.error("Error proxying TV stream:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// ================== START & SHUTDOWN ==================
const server = app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

async function shutdown() {
  console.log("Shutting down...");
  try { server.close(); } catch {}
  try { if (browser) await browser.close(); } catch {}
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);