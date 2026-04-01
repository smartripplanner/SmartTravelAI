const express = require("express");
const bodyParser = require("body-parser");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");
const cors = require("cors");
const dns = require("dns");
const compression = require("compression");

// FIX FOR RENDER EMAIL BUG: Force Node.js to use IPv4 to prevent ENETUNREACH errors
dns.setDefaultResultOrder('ipv4first');

const app = express();

// ── CORS — must be absolute first, before compression and body parsers ──
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
    if (req.method === 'OPTIONS') return res.sendStatus(200); // kill pre-flight immediately
    next();
});

app.use(compression());
app.use(cors({ origin: '*' })); // keep cors() as secondary safety net
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

// Health Check
app.get("/", (req, res) => {
    res.json({ status: "ok", message: "✈️ TravelAI Backend is Live!", version: "3.0.0" });
});

// ═══════════════════════════════════════════════
// ENVIRONMENT VARIABLES
// ═══════════════════════════════════════════════
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MAPS_API_KEY = process.env.MAPS_API_KEY;
const EMAIL_USER = process.env.EMAIL_USER;
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "admin@travelai.com").split(",").map(e => e.trim());

if (!GEMINI_API_KEY) console.error("⚠️ WARNING: GEMINI_API_KEY missing.");
if (!MAPS_API_KEY)   console.error("⚠️ WARNING: MAPS_API_KEY missing.");
if (!BREVO_API_KEY)  console.error("⚠️ WARNING: BREVO_API_KEY missing.");

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// --- IATA CODE MAPPER ---
const getIATACode = (city) => {
    const map = {
        "mumbai":"BOM","delhi":"DEL","bangalore":"BLR","bengaluru":"BLR",
        "chennai":"MAA","kolkata":"CCU","hyderabad":"HYD","pune":"PNQ",
        "ahmedabad":"AMD","jaipur":"JAI","kochi":"COK","goa":"GOI",
        "bangkok":"BKK","phuket":"HKT","dubai":"DXB","singapore":"SIN",
        "amsterdam":"AMS","paris":"CDG","london":"LHR","tokyo":"NRT",
        "new york":"JFK","bali":"DPS","kuala lumpur":"KUL","hong kong":"HKG",
        "sydney":"SYD","rome":"FCO","barcelona":"BCN","istanbul":"IST",
        "maldives":"MLE","sri lanka":"CMB","zurich":"ZRH","madrid":"MAD",
        "milan":"MXP","berlin":"BER","dubai":"DXB","abu dhabi":"AUH",
        "doha":"DOH","cairo":"CAI","johannesburg":"JNB","nairobi":"NBO",
        "los angeles":"LAX","toronto":"YYZ","vancouver":"YVR","seoul":"ICN",
        "beijing":"PEK","shanghai":"PVG","taipei":"TPE","manila":"MNL",
        "ho chi minh":"SGN","hanoi":"HAN","jakarta":"CGK","colombo":"CMB"
    };
    if (!city || typeof city !== 'string') return 'N/A';
    return map[city.toLowerCase().trim()] || city.substring(0, 3).toUpperCase();
};

// ═══════════════════════════════════════════════
// 1. GENERATE ITINERARY (Single or Multi-City)
// ═══════════════════════════════════════════════
app.post("/generate", async (req, res) => {
    if (!genAI) return res.status(500).json({ error: "Gemini API key is not configured." });

    const {
        from        = '',
        destination = '',
        budget      = '20000',
        days        = '3',
        date        = '',
        style       = 'budget',
        travelers   = 'solo',
        pace        = 'normal',
        interests   = 'nature',
        cities      = ''
    } = req.body;

    // Multi-city support
    const isMultiCity = cities && typeof cities === 'string' && cities.trim().length > 2;
    let parsedCities = [];
    try { parsedCities = isMultiCity ? JSON.parse(cities) : []; } catch(e) {}

    // Derive destination from first multi-city entry if destination is blank
    const effectiveDestination = destination || (parsedCities[0]?.city) || 'Unknown';
    const effectiveFrom        = from || 'Unknown';

    const travelStyle = style === "luxury" ? "luxury 5-star" : style === "mid" ? "mid-range comfortable" : style === "adventure" ? "adventure-focused" : style === "relax" ? "relaxing & leisurely" : "budget-friendly";
    const travelPace = pace === "slow" ? "slow (max 2-3 places per day)" : pace === "fast" ? "fast (5-6 places per day)" : "normal (3-4 places per day)";
    const interestsList = interests ? interests.split(',').join(', ') : "general sightseeing";
    const parsedDays = parseInt(days) || 3;

    // Build destination string for multi-city
    const destDisplay = isMultiCity && parsedCities.length > 0
        ? parsedCities.map(c => `${c.city} (${c.days} days)`).join(' → ')
        : destination;

    const totalDays = isMultiCity && parsedCities.length > 0
        ? parsedCities.reduce((s, c) => s + parseInt(c.days || 1), 0)
        : parsedDays;

    // Build itinerary instruction for multi-city
    const itineraryInstruction = isMultiCity && parsedCities.length > 0
        ? parsedCities.map((c, i) => {
            const startDay = parsedCities.slice(0, i).reduce((s, x) => s + parseInt(x.days || 1), 1);
            const endDay = startDay + parseInt(c.days || 1) - 1;
            return `Days ${startDay}-${endDay}: ${c.city}`;
          }).join(', ')
        : `All ${totalDays} days in ${effectiveDestination}`;

    const prompt = `
You are an elite AI travel planner API. Create a hyper-personalized travel itinerary.

TRIP DETAILS:
- From: ${effectiveFrom} → Destination: ${destDisplay}
- Travelers: ${travelers} | Style: ${travelStyle} | Pace: ${travelPace}
- Interests: ${interestsList} | Budget: ₹${budget} | Days: ${totalDays} | Date: ${date}
- Day Plan: ${itineraryInstruction}

CRITICAL RULES:
1. Output EXACTLY ${totalDays} day objects in "itinerary" array.
2. Return EXACTLY 3 hotel options (budget, mid, luxury categories).
3. Return EXACTLY 3 flight options (cheapest, fastest, best_value categories).
4. Tailor places based on interests.
5. All hotel/flight names MUST be realistic for ${destDisplay}.
6. For multi-city trips, label day themes with the city name.

Return ONLY this JSON (no markdown, no extra text):
{
  "flights": [
    {
      "category": "cheapest",
      "categoryLabel": "💸 Cheapest Option",
      "airline": "Real Airline Name",
      "code": "FL-123",
      "price": "₹8500",
      "outbound": {"time": "06:00 AM → 08:30 AM", "duration": "2h 30m", "stops": "1 Stop"},
      "inbound": {"time": "08:00 PM → 10:30 PM", "duration": "2h 30m", "stops": "1 Stop"}
    },
    {
      "category": "fastest",
      "categoryLabel": "⚡ Fastest Route",
      "airline": "Different Airline",
      "code": "FL-456",
      "price": "₹12000",
      "outbound": {"time": "10:00 AM → 12:00 PM", "duration": "2h 00m", "stops": "Non-stop"},
      "inbound": {"time": "06:00 PM → 08:00 PM", "duration": "2h 00m", "stops": "Non-stop"}
    },
    {
      "category": "best_value",
      "categoryLabel": "⭐ Best Value",
      "airline": "Third Airline",
      "code": "FL-789",
      "price": "₹10000",
      "outbound": {"time": "08:00 AM → 10:30 AM", "duration": "2h 30m", "stops": "Non-stop"},
      "inbound": {"time": "07:00 PM → 09:30 PM", "duration": "2h 30m", "stops": "Non-stop"}
    }
  ],
  "hotels": [
    {
      "category": "budget",
      "categoryLabel": "🎒 Budget Stay",
      "name": "Real Budget Hotel in ${effectiveDestination}",
      "rating": "3.0★",
      "price": "₹1500/night",
      "address": "Budget Area, ${effectiveDestination}",
      "amenities": ["WiFi", "AC", "Breakfast"]
    },
    {
      "category": "mid",
      "categoryLabel": "🏙️ Mid-Range",
      "name": "Real Mid Hotel in ${effectiveDestination}",
      "rating": "4.0★",
      "price": "₹4500/night",
      "address": "Central Area, ${effectiveDestination}",
      "amenities": ["WiFi", "Pool", "Restaurant", "Gym"]
    },
    {
      "category": "luxury",
      "categoryLabel": "👑 Luxury",
      "name": "Real Luxury Hotel in ${effectiveDestination}",
      "rating": "5.0★",
      "price": "₹12000/night",
      "address": "Premium Area, ${effectiveDestination}",
      "amenities": ["WiFi", "Infinity Pool", "Spa", "Fine Dining", "Concierge"]
    }
  ],
  "itinerary": [
    {
      "day": 1,
      "city": "${effectiveDestination}",
      "theme": "Arrival & Exploration",
      "places": ["Exact Famous Place 1", "Exact Famous Place 2", "Exact Famous Place 3"],
      "imageSearchQueries": ["Exact Famous Place 1 ${effectiveDestination}", "Exact Famous Place 2 ${effectiveDestination}", "Exact Famous Place 3 ${effectiveDestination}"],
      "food": "Restaurant Name — Dish (e.g. Café De Sol — Fish Curry ₹350)",
      "transport": "Mode — e.g. Taxi ₹500 or Metro ₹50",
      "cost": "₹2000",
      "note": "Practical tip for this day"
    }
  ],
  "budget_breakdown": {
    "flights": "₹8000",
    "hotels": "₹12000",
    "food": "₹3000",
    "transport": "₹1500",
    "activities": "₹500",
    "budget_total": "₹15000",
    "midrange_total": "₹30000",
    "luxury_total": "₹65000"
  },
  "best_time": {
    "best_months": "October to March",
    "weather_summary": "Pleasant, 20-28°C, low humidity",
    "peak_season": "December - January (crowds & prices high)",
    "off_season": "June - August (monsoon, cheaper deals)",
    "cheapest_months": "July - August"
  },
  "visa_info": {
    "required": true,
    "type": "Tourist Visa (e-Visa available)",
    "processing_time": "3-5 business days",
    "cost_approx": "₹5000 (~$60 USD)",
    "validity": "30 days single entry",
    "website": "https://evisa.gov.example.com",
    "notes": "Apply at least 2 weeks before travel"
  },
  "nearby_places": [
    {"name": "Nearby Place 1", "distance": "45 km", "type": "Beach / Hill / City"},
    {"name": "Nearby Place 2", "distance": "80 km", "type": "Historical Site"},
    {"name": "Nearby Place 3", "distance": "120 km", "type": "Nature Reserve"}
  ],
  "packing_list": {
    "documents": ["Passport", "Visa Copy", "Hotel Confirmations", "Travel Insurance"],
    "clothes": ["Light summer clothes", "Comfortable walking shoes", "Rain jacket"],
    "essentials": ["Sunscreen SPF 50", "Insect repellent", "Basic medicines"],
    "tech": ["Universal adapter", "Power bank", "Camera"],
    "local_tips": ["Download offline maps", "Keep local currency"]
  },
  "totalEstimatedCost": "₹25000"
}`;

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const result = await model.generateContent(prompt);
        let text = result.response.text().replace(/```json/g, "").replace(/```/g, "").trim();
        // Robustly extract JSON — find outermost { ... } in case Gemini adds extra text
        const jsonStart = text.indexOf('{');
        const jsonEnd   = text.lastIndexOf('}');
        if (jsonStart === -1 || jsonEnd === -1) throw new Error("No JSON object found in Gemini response");
        text = text.slice(jsonStart, jsonEnd + 1);
        const data = JSON.parse(text);
        data.meta = {
            originCode: getIATACode(effectiveFrom),
            destCode: getIATACode(effectiveDestination),
            isMultiCity,
            cities: parsedCities
        };
        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify(data));
    } catch (error) {
        console.error("Gemini Error:", error);
        res.status(500).json({ error: "Error generating itinerary. Please try again." });
    }
});

// ═══════════════════════════════════════════════
// 2. AI CHATBOT
// ═══════════════════════════════════════════════
app.post("/chat", async (req, res) => {
    if (!genAI) return res.status(500).json({ error: "Gemini API key is not configured." });
    const { message, destination, context } = req.body;
    if (!message) return res.status(400).json({ error: "No message provided." });
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const chatPrompt = `You are TravelAI, a friendly AI travel assistant for ${destination || 'various destinations'}.
Context: ${context || 'User is planning a trip.'}
Answer concisely (max 3-4 sentences). Use emojis sparingly.
Question: ${message}`;
        const result = await model.generateContent(chatPrompt);
        res.json({ reply: result.response.text().trim() });
    } catch (error) {
        res.status(500).json({ error: "Chat unavailable." });
    }
});

// ═══════════════════════════════════════════════
// 3. CURRENCY CONVERTER
// ═══════════════════════════════════════════════
app.get("/currency", async (req, res) => {
    try {
        const response = await axios.get("https://api.exchangerate-api.com/v4/latest/INR");
        res.json({ rates: response.data.rates, base: "INR" });
    } catch {
        res.json({ base: "INR", rates: { USD:0.012,EUR:0.011,GBP:0.0095,JPY:1.78,AED:0.044,SGD:0.016,THB:0.42,AUD:0.018 } });
    }
});

// ═══════════════════════════════════════════════
// 4. NEARBY PLACES
// ═══════════════════════════════════════════════
app.get("/nearby-places", async (req, res) => {
    const { destination } = req.query;
    if (!destination || !MAPS_API_KEY) return res.json({ places: [] });
    try {
        const geoRes = await axios.get(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(destination)}&key=${MAPS_API_KEY}`);
        const location = geoRes.data.results?.[0]?.geometry?.location;
        if (!location) return res.json({ places: [] });
        const placesRes = await axios.get(`https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${location.lat},${location.lng}&radius=15000&type=tourist_attraction&key=${MAPS_API_KEY}`);
        const places = (placesRes.data.results || []).slice(0, 6).map(p => ({
            name: p.name, rating: p.rating, vicinity: p.vicinity, types: p.types?.slice(0, 2).join(', ')
        }));
        res.json({ places });
    } catch(e) { res.json({ places: [] }); }
});

// ═══════════════════════════════════════════════
// 5. EMAIL ITINERARY (Brevo API)
// ═══════════════════════════════════════════════
app.post("/email-itinerary", async (req, res) => {
    const { email, destination, days, from, style, budget, travelDate, itinerary, totalCost } = req.body;
    if (!email || !destination) return res.status(400).json({ error: "Email and destination required." });
    if (!BREVO_API_KEY || !EMAIL_USER) return res.status(500).json({ error: "Email API not configured." });

    const tripStyle = style ? style.charAt(0).toUpperCase() + style.slice(1) : 'Standard';
    const estCost = totalCost || (budget ? '₹' + parseInt(budget).toLocaleString('en-IN') : '—');

    const dayCardsHtml = (itinerary || []).map(day => `
      <tr>
        <td style="padding:6px 32px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0"
            style="background-color:#1a2235;border:1px solid rgba(212,167,106,0.15);border-radius:12px;overflow:hidden;margin-bottom:4px;">
            <tr>
              <td style="padding:14px 20px;background:rgba(212,167,106,0.08);border-bottom:1px solid rgba(212,167,106,0.15);">
                <table width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td>
                      <span style="font-family:Georgia,'Times New Roman',serif;font-size:17px;color:#d4a76a;font-weight:600;">Day ${day.day}</span>
                      ${day.theme ? `<span style="font-size:12px;color:rgba(212,167,106,0.65);margin-left:10px;">— ${day.theme}</span>` : ''}
                    </td>
                    <td align="right"><span style="font-size:13px;color:#d4a76a;font-weight:600;">${day.cost || ''}</span></td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 20px 8px;">
                <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:rgba(245,240,232,0.35);margin-bottom:8px;">📍 Places to Visit</div>
                <div>${(day.places || []).map(p => `<span style="display:inline-block;background:rgba(212,167,106,0.1);border:1px solid rgba(212,167,106,0.22);color:#d4a76a;padding:3px 11px;border-radius:20px;font-size:12px;margin:2px 3px 2px 0;">${p}</span>`).join('')}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 20px 14px;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td width="50%" valign="top" style="padding-right:8px;">
                      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:11px 13px;">
                        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:rgba(245,240,232,0.38);margin-bottom:5px;">🍴 Food</div>
                        <div style="font-size:13px;color:#f5f0e8;line-height:1.55;">${day.food || '—'}</div>
                      </div>
                    </td>
                    <td width="50%" valign="top" style="padding-left:8px;">
                      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:11px 13px;">
                        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:rgba(245,240,232,0.38);margin-bottom:5px;">🚕 Transport</div>
                        <div style="font-size:13px;color:#f5f0e8;line-height:1.55;">${day.transport || '—'}</div>
                      </div>
                    </td>
                  </tr>
                </table>
                ${day.note ? `<div style="margin-top:8px;background:rgba(212,167,106,0.06);border:1px solid rgba(212,167,106,0.15);border-radius:8px;padding:9px 13px;font-size:12px;color:rgba(245,240,232,0.7);line-height:1.5;">💡 <strong style="color:#d4a76a;">Pro Tip:</strong> ${day.note}</div>` : ''}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    `).join('');

    const htmlContent = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN">
<html><head><meta http-equiv="Content-Type" content="text/html;charset=UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Your TravelAI Itinerary</title></head>
<body style="margin:0;padding:0;background-color:#0d1117;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0d1117;">
    <tr><td align="center" style="padding:28px 12px;">
      <table width="600" cellpadding="0" cellspacing="0" border="0"
        style="max-width:600px;width:100%;background-color:#0a0f1a;border-radius:16px;overflow:hidden;border:1px solid rgba(212,167,106,0.15);">
        <tr>
          <td style="background:linear-gradient(135deg,#0a0f1a 0%,#1a2235 100%);padding:36px 40px 28px;text-align:center;border-bottom:1px solid rgba(212,167,106,0.18);">
            <div style="font-family:Georgia,serif;font-size:13px;letter-spacing:0.22em;text-transform:uppercase;color:#d4a76a;margin-bottom:14px;">✈ TravelAI</div>
            <h1 style="font-family:Georgia,serif;color:#f5f0e8;font-size:30px;font-weight:300;margin:0 0 10px;line-height:1.2;">Your Trip to ${effectiveDestination}</h1>
            <p style="color:rgba(245,240,232,0.48);font-size:13px;margin:0;">${days} Days &nbsp;·&nbsp; ${effectiveFrom || 'Home'} → ${effectiveDestination} &nbsp;·&nbsp; ${tripStyle} Style</p>
          </td>
        </tr>
        <tr>
          <td style="background:#111827;padding:20px 32px;border-bottom:1px solid rgba(255,255,255,0.06);">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" width="25%" style="padding:0 6px;">
                  <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.1em;color:rgba(245,240,232,0.36);margin-bottom:5px;">Duration</div>
                  <div style="font-size:15px;font-weight:700;color:#d4a76a;">${days} Days</div>
                </td>
                <td align="center" width="25%" style="padding:0 6px;border-left:1px solid rgba(255,255,255,0.07);">
                  <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.1em;color:rgba(245,240,232,0.36);margin-bottom:5px;">From</div>
                  <div style="font-size:15px;font-weight:700;color:#d4a76a;">${from || '—'}</div>
                </td>
                <td align="center" width="25%" style="padding:0 6px;border-left:1px solid rgba(255,255,255,0.07);">
                  <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.1em;color:rgba(245,240,232,0.36);margin-bottom:5px;">Style</div>
                  <div style="font-size:15px;font-weight:700;color:#d4a76a;">${tripStyle}</div>
                </td>
                <td align="center" width="25%" style="padding:0 6px;border-left:1px solid rgba(255,255,255,0.07);">
                  <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.1em;color:rgba(245,240,232,0.36);margin-bottom:5px;">Est. Budget</div>
                  <div style="font-size:15px;font-weight:700;color:#d4a76a;">${estCost}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px 10px;">
            <h2 style="font-family:Georgia,serif;font-size:20px;font-weight:400;color:#f5f0e8;margin:0 0 4px;">🗓 Day-by-Day Itinerary</h2>
            <p style="font-size:11px;color:rgba(245,240,232,0.38);margin:0;">Curated by TravelAI based on your preferences</p>
          </td>
        </tr>
        ${dayCardsHtml}
        <tr><td style="padding:4px 0;"></td></tr>
        <tr>
          <td style="padding:28px 40px 24px;text-align:center;border-top:1px solid rgba(255,255,255,0.06);">
            <p style="color:rgba(245,240,232,0.5);font-size:14px;margin:0 0 18px;line-height:1.6;">Want to explore more destinations or tweak this plan?</p>
            <a href="https://amazing-travel-123.netlify.app/" style="display:inline-block;background:linear-gradient(135deg,#d4a76a,#c8941a);color:#0a0f1a;text-decoration:none;padding:13px 30px;border-radius:50px;font-size:13px;font-weight:700;letter-spacing:0.06em;">✨ Plan Another Trip</a>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 40px 22px;background:#050a12;text-align:center;">
            <p style="color:rgba(245,240,232,0.22);font-size:11px;margin:0;line-height:1.7;">
              Generated by <strong style="color:rgba(212,167,106,0.5);">TravelAI</strong> — Powered by SmartTripPlanner AI<br>
              Flight &amp; hotel prices are estimates only. Always verify before booking.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

    try {
        await axios.post('https://api.brevo.com/v3/smtp/email', {
            sender: { email: EMAIL_USER, name: "TravelAI Planner" },
            to: [{ email }],
            subject: `✈️ Your ${days}-Day ${destination || effectiveDestination} Itinerary — TravelAI`,
            htmlContent
        }, { headers: { 'accept':'application/json','api-key':BREVO_API_KEY,'content-type':'application/json' } });
        res.json({ success: true });
    } catch(e) {
        console.error("Brevo Email error:", e.response ? e.response.data : e.message);
        res.status(500).json({ error: "Email send failed." });
    }
});

// ═══════════════════════════════════════════════
// 6. IMAGE FETCHER
// ═══════════════════════════════════════════════
app.get("/get-image", async (req, res) => {
    try {
        const { query, type } = req.query;
        if (!query) return res.json({ imageUrl: 'https://placehold.co/800x600/1a2235/d4a76a?text=Travel' });
        const cleanQuery = query.replace(/[^a-zA-Z0-9 ]/g, "").trim();

        const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=pageimages&format=json&piprop=thumbnail&pithumbsize=800&generator=search&gsrsearch=${encodeURIComponent(cleanQuery)}&gsrlimit=3`;
        const wikiRes = await axios.get(wikiUrl, { headers: { 'User-Agent': 'TravelAI_App/2.0' } });

        const pages = wikiRes.data.query?.pages;
        if (pages) {
            const pageIds = Object.keys(pages);
            for (const pageId of pageIds) {
                const src = pages[pageId].thumbnail?.source;
                if (src && !src.toLowerCase().endsWith('.svg') && !src.toLowerCase().includes('map') && !src.toLowerCase().includes('flag')) {
                    return res.json({ imageUrl: src });
                }
            }
        }

        const flickrKeywords = cleanQuery.split(" ").slice(0, 3).join(",");
        const fallback = type === 'hotel' ? `hotel,resort,${flickrKeywords}` : flickrKeywords;
        res.json({ imageUrl: `https://loremflickr.com/800/600/${encodeURIComponent(fallback)}/all` });
    } catch (error) {
        res.json({ imageUrl: `https://placehold.co/800x600/1a2235/d4a76a?text=${encodeURIComponent((req.query.query || 'place').split(' ')[0])}` });
    }
});

// ═══════════════════════════════════════════════
// 7. SMART PACKING LIST
// ═══════════════════════════════════════════════
app.post("/packing-list", async (req, res) => {
    if (!genAI) return res.status(500).json({ error: "Gemini API key not configured." });
    const { destination, days, style, date } = req.body;
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const prompt = `Generate a smart packing list for a ${days}-day ${style} trip to ${destination} on ${date}.
Return ONLY JSON:
{"documents":[],"clothes":[],"essentials":[],"tech":[],"money":[],"local_tips":[]}`;
        const result = await model.generateContent(prompt);
        let text = result.response.text().replace(/```json/g,"").replace(/```/g,"").trim();
        res.json(JSON.parse(text));
    } catch(e) { res.status(500).json({ error: "Could not generate packing list." }); }
});

// ═══════════════════════════════════════════════
// 8. USAGE TRACKING
// ═══════════════════════════════════════════════
// Simple in-memory daily counter (frontend uses Firestore for persistence)
const usageStore = new Map();

app.post("/usage/check", (req, res) => {
    const { userId, isLoggedIn } = req.body;
    const today = new Date().toISOString().split('T')[0];
    const key = `${userId || req.ip}_${today}`;
    const count = usageStore.get(key) || 0;
    const limit = isLoggedIn ? 10 : 2;
    res.json({ allowed: count < limit, count, limit, remaining: Math.max(0, limit - count) });
});

app.post("/usage/increment", (req, res) => {
    const { userId } = req.body;
    const today = new Date().toISOString().split('T')[0];
    const key = `${userId || req.ip}_${today}`;
    const count = (usageStore.get(key) || 0) + 1;
    usageStore.set(key, count);
    res.json({ success: true, count });
});

// ═══════════════════════════════════════════════
// 9. ROUTE DISTANCE (Google Directions)
// ═══════════════════════════════════════════════
app.post("/route-info", async (req, res) => {
    const { origin, destination: dest, waypoints } = req.body;
    if (!MAPS_API_KEY) return res.json({ distance: null, duration: null });
    try {
        const waypointStr = (waypoints || []).join('|');
        const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&waypoints=${encodeURIComponent(waypointStr)}&key=${MAPS_API_KEY}`;
        const response = await axios.get(url);
        const route = response.data.routes?.[0];
        if (!route) return res.json({ distance: null, duration: null });
        let totalDistance = 0, totalDuration = 0;
        route.legs.forEach(leg => {
            totalDistance += leg.distance?.value || 0;
            totalDuration += leg.duration?.value || 0;
        });
        res.json({
            distance: (totalDistance / 1000).toFixed(1) + ' km',
            duration: Math.round(totalDuration / 60) + ' min',
            legs: route.legs.map(l => ({ distance: l.distance?.text, duration: l.duration?.text }))
        });
    } catch(e) { res.json({ distance: null, duration: null }); }
});

// ═══════════════════════════════════════════════
// 10. ADMIN ENDPOINTS (simple email-based auth)
// ═══════════════════════════════════════════════
function isAdmin(email) {
    return ADMIN_EMAILS.includes(email);
}

app.get("/admin/check", (req, res) => {
    const { email } = req.query;
    res.json({ isAdmin: isAdmin(email || '') });
});

app.post("/admin/blog", async (req, res) => {
    // Blog post creation - validates admin then returns structured data
    // Actual persistence handled by Firestore on frontend
    const { adminEmail, title, content, slug, excerpt, category } = req.body;
    if (!isAdmin(adminEmail)) return res.status(403).json({ error: "Not authorized." });
    if (!title || !content) return res.status(400).json({ error: "Title and content required." });
    res.json({
        success: true,
        post: { title, content, slug: slug || title.toLowerCase().replace(/[^a-z0-9]+/g,'-'), excerpt, category, createdAt: new Date().toISOString() }
    });
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✈  TravelAI Backend v3.0 running on Port ${PORT}`);
});
