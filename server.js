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
const ALLOWED_ORIGINS = [
    'https://smarttripplannerai.netlify.app',
    'https://amazing-travel-123.netlify.app'
];

app.use((req, res, next) => {
    const origin = req.headers.origin;
    // Reflect the exact origin back so credentialed requests also work;
    // fall back to * for non-browser / unknown origins.
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
    if (req.method === 'OPTIONS') return res.sendStatus(200); // kill pre-flight immediately
    next();
});

app.use(compression());
app.use(cors({ origin: ALLOWED_ORIGINS, optionsSuccessStatus: 200 })); // secondary safety net
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

// Health Check
app.get("/", (req, res) => {
    res.json({ status: "ok", message: "✈️ SmartTripPlanner AI Backend is Live!", version: "3.0.0" });
});

// ═══════════════════════════════════════════════
// ENVIRONMENT VARIABLES
// ═══════════════════════════════════════════════
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;
const MAPS_API_KEY    = process.env.MAPS_API_KEY;
const EMAIL_USER      = process.env.EMAIL_USER;
const BREVO_API_KEY   = process.env.BREVO_API_KEY;
const ADMIN_EMAILS    = (process.env.ADMIN_EMAILS || "smartripplanner@gmail.com").split(",").map(e => e.trim());

if (!GEMINI_API_KEY) console.error("⚠️ WARNING: GEMINI_API_KEY missing.");
if (!MAPS_API_KEY)   console.error("⚠️ WARNING: MAPS_API_KEY missing — Google Places images disabled.");
if (!BREVO_API_KEY)  console.error("⚠️ WARNING: BREVO_API_KEY missing.");

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// ── TRIP STORE (in-memory, capped at 500 trips) ─────────────────────────────
const trips = new Map();

function generateTripId() {
    const year = new Date().getFullYear();
    const rand = Math.floor(1000 + Math.random() * 9000);
    return `TRIP-${year}-${rand}`;
}

// ═══════════════════════════════════════════════
// REALISTIC BUDGET CALCULATION MODULE
// ═══════════════════════════════════════════════
// Per-day/per-trip costs in INR: [budget, mid-range, luxury]
const COST_TABLE = {
    india:          { flights:[5000,8000,15000],     hotel:[1200,4000,12000],  food:[500,1500,4000],   transport:[300,800,2500],   activities:[200,600,2000],   visa:0,     insurance:[40,60,100] },
    south_asia:     { flights:[8000,15000,30000],    hotel:[1500,4500,15000],  food:[600,1800,5000],   transport:[400,1000,3000],  activities:[400,1000,3000],  visa:2000,  insurance:[50,80,120] },
    southeast_asia: { flights:[15000,22000,40000],   hotel:[2000,5500,18000],  food:[1000,2500,6000],  transport:[500,1500,4000],  activities:[500,1500,4000],  visa:2000,  insurance:[60,90,130] },
    east_asia:      { flights:[25000,40000,75000],   hotel:[4000,10000,30000], food:[2000,4000,10000], transport:[1000,2500,6000], activities:[800,2000,5000],  visa:4000,  insurance:[80,120,180] },
    middle_east:    { flights:[15000,25000,50000],   hotel:[3000,8000,25000],  food:[1500,3500,8000],  transport:[600,2000,5000],  activities:[800,2000,5000],  visa:5000,  insurance:[60,100,150] },
    europe:         { flights:[35000,55000,120000],  hotel:[5000,12000,35000], food:[2500,5000,12000], transport:[1000,2500,7000], activities:[1000,2500,6000], visa:7000,  insurance:[100,150,220] },
    north_america:  { flights:[50000,75000,150000],  hotel:[6000,15000,40000], food:[3000,6000,15000], transport:[1500,3000,8000], activities:[1000,3000,7000], visa:14000, insurance:[120,180,260] },
    oceania:        { flights:[40000,65000,130000],   hotel:[5000,13000,35000], food:[2500,5500,14000], transport:[1200,3000,8000], activities:[1000,2500,6000], visa:8000,  insurance:[100,160,240] },
    africa:         { flights:[30000,50000,100000],  hotel:[2500,7000,25000],  food:[1200,3000,8000],  transport:[800,2000,6000],  activities:[1000,3000,8000], visa:4000,  insurance:[80,130,200] },
    south_america:  { flights:[60000,85000,160000],  hotel:[3000,8000,25000],  food:[1500,3500,9000],  transport:[800,2000,6000],  activities:[800,2000,5000],  visa:5000,  insurance:[100,150,220] },
    central_asia:   { flights:[20000,35000,60000],   hotel:[2500,6000,18000],  food:[1000,2500,6000],  transport:[500,1500,4000],  activities:[500,1200,3000],  visa:3000,  insurance:[60,100,150] }
};

function detectCostRegion(destination) {
    const d = String(destination || '').toLowerCase();
    const map = {
        india:          ['india','delhi','mumbai','bangalore','bengaluru','chennai','kolkata','hyderabad','jaipur','goa','kerala','manali','shimla','rishikesh','udaipur','varanasi','agra','pune','kochi','darjeeling','ladakh','kashmir','andaman','ooty','munnar','mysore','hampi','amritsar','jodhpur','coorg','gangtok','leh','srinagar','dehradun','nainital','mussoorie','pondicherry','chandigarh','ahmedabad','lucknow','bhopal','indore','rajasthan','himachal','uttarakhand','karnataka','tamil nadu','gujarat','maharashtra','madhya pradesh','west bengal','odisha','sikkim','meghalaya','assam'],
        south_asia:     ['nepal','kathmandu','pokhara','bhutan','thimphu','paro','sri lanka','colombo','kandy','ella','sigiriya','galle','maldives','male','bangladesh','dhaka','pakistan','islamabad','lahore'],
        southeast_asia: ['thailand','bangkok','phuket','chiang mai','pattaya','krabi','vietnam','hanoi','ho chi minh','da nang','hoi an','indonesia','bali','jakarta','malaysia','kuala lumpur','langkawi','penang','philippines','manila','cebu','boracay','palawan','cambodia','siem reap','phnom penh','laos','luang prabang','myanmar','yangon','bagan','singapore'],
        east_asia:      ['japan','tokyo','osaka','kyoto','hokkaido','hiroshima','south korea','seoul','busan','jeju','china','beijing','shanghai','hong kong','guangzhou','chengdu','taiwan','taipei','macau'],
        middle_east:    ['dubai','abu dhabi','uae','saudi arabia','riyadh','jeddah','qatar','doha','oman','muscat','bahrain','kuwait','jordan','amman','petra','turkey','istanbul','cappadocia','antalya','israel','jerusalem','tel aviv','lebanon','beirut','egypt','cairo','luxor'],
        europe:         ['france','paris','nice','london','uk','england','scotland','edinburgh','italy','rome','venice','florence','milan','spain','barcelona','madrid','germany','berlin','munich','switzerland','zurich','geneva','interlaken','amsterdam','netherlands','austria','vienna','greece','athens','santorini','mykonos','portugal','lisbon','porto','belgium','brussels','czech','prague','hungary','budapest','poland','warsaw','krakow','croatia','dubrovnik','denmark','copenhagen','sweden','stockholm','norway','oslo','finland','helsinki','iceland','reykjavik','ireland','dublin','romania','bucharest','serbia','belgrade','montenegro','russia','moscow','st petersburg'],
        north_america:  ['usa','united states','new york','los angeles','san francisco','las vegas','miami','chicago','boston','washington','seattle','hawaii','orlando','canada','toronto','vancouver','montreal','mexico','cancun','mexico city','caribbean','jamaica','bahamas','cuba','costa rica','panama'],
        oceania:        ['australia','sydney','melbourne','brisbane','perth','gold coast','cairns','new zealand','auckland','queenstown','christchurch','fiji','tahiti','bora bora'],
        africa:         ['south africa','cape town','johannesburg','kenya','nairobi','masai mara','tanzania','serengeti','zanzibar','kilimanjaro','morocco','marrakech','casablanca','ethiopia','addis ababa','ghana','accra','nigeria','lagos','mauritius','seychelles','madagascar','tunisia','namibia','botswana','rwanda','uganda','zimbabwe','victoria falls'],
        south_america:  ['brazil','rio de janeiro','sao paulo','argentina','buenos aires','patagonia','peru','lima','cusco','machu picchu','colombia','bogota','cartagena','medellin','chile','santiago','ecuador','quito','galapagos','bolivia','la paz','uyuni','uruguay'],
        central_asia:   ['uzbekistan','tashkent','samarkand','kazakhstan','almaty','kyrgyzstan','tajikistan','turkmenistan','georgia','tbilisi','armenia','yerevan','azerbaijan','baku','mongolia','ulaanbaatar']
    };
    for (const [region, keywords] of Object.entries(map)) {
        if (keywords.some(k => d.includes(k))) return region;
    }
    return 'southeast_asia';
}

function calculateBudgetReference(destination, from, numDays, style) {
    const region     = detectCostRegion(destination);
    const fromRegion = detectCostRegion(from);
    const si         = style === 'luxury' ? 2 : (style === 'mid' ? 1 : 0);
    const costs      = COST_TABLE[region] || COST_TABLE.southeast_asia;
    const d          = Math.max(1, parseInt(numDays) || 3);

    const calc = (idx) => {
        const f = costs.flights[idx];
        const h = costs.hotel[idx] * d;
        const fd = costs.food[idx] * d;
        const t = costs.transport[idx] * d;
        const a = costs.activities[idx] * d;
        const v = (fromRegion === region && region === 'india') ? 0 : costs.visa;
        const ins = costs.insurance[idx] * d;
        const sub = f + h + fd + t + a + v + ins;
        const misc = Math.round(sub * 0.12);
        return { flights:f, hotels:h, food:fd, transport:t, activities:a, visa:v, insurance:ins, misc, total: sub + misc };
    };

    const selected = calc(si);
    const tiers    = [calc(0), calc(1), calc(2)];

    return { ...selected, budget_total: tiers[0].total, midrange_total: tiers[1].total, luxury_total: tiers[2].total, region, days: d };
}

// Build a compact plain-text summary of a trip for chatbot context
function buildTripContext(data) {
    const meta   = data.meta || {};
    const bd     = data.budget_breakdown || {};
    const itin   = (data.itinerary || []).map(d =>
        `Day ${d.day}${d.city ? ` (${d.city})` : ''}: ${(d.places || []).join(', ')} | Food: ${d.food || '—'} | Transport: ${d.transport || '—'} | Cost: ${d.cost || '—'} | Note: ${d.note || ''}`
    ).join('\n');

    let hotelsSummary = '';
    if (data.hotels) {
        hotelsSummary = data.hotels.map(h => `${h.category}: ${h.name} at ${h.address} (${h.price}, ${h.rating})`).join('\n');
    } else if (data.hotels_by_city) {
        hotelsSummary = Object.entries(data.hotels_by_city).map(([city, hs]) =>
            `${city}:\n` + hs.map(h => `  ${h.category}: ${h.name} (${h.price}, ${h.rating})`).join('\n')
        ).join('\n');
    }

    return [
        `Trip ID: ${meta.tripId || 'N/A'}`,
        `Destination: ${meta.tripTitle || '—'} | From: ${meta.firstCity || '—'} | Mode: ${meta.travelMode || 'flight'}`,
        `Duration: ${(data.itinerary || []).length} days | Total cost: ${data.totalEstimatedCost || '—'}`,
        `Budget — Flights: ${bd.flights || '—'}, Hotels: ${bd.hotels || '—'}, Food: ${bd.food || '—'}, Transport: ${bd.transport || '—'}, Activities: ${bd.activities || '—'}, Visa: ${bd.visa || '—'}, Insurance: ${bd.insurance || '—'}, Misc: ${bd.misc || '—'}`,
        `Best time: ${data.best_time?.best_months || '—'} (${data.best_time?.weather_summary || ''})`,
        `Visa: ${data.visa_info?.type || 'N/A'} | Cost: ${data.visa_info?.cost_approx || '—'} | Processing: ${data.visa_info?.processing_time || '—'}`,
        `Hotels:\n${hotelsSummary}`,
        `Itinerary:\n${itin}`
    ].join('\n');
}

// ── IMAGE CACHE (in-memory, capped at 600 entries) ──────────────────────────
const imageCache = new Map();
function cacheSet(key, url) {
    if (imageCache.size >= 600) imageCache.delete(imageCache.keys().next().value);
    imageCache.set(key, url);
}

// Deterministic numeric seed from a string (for consistent AI-generated images per place)
function strSeed(str) {
    return Math.abs([...str].reduce((h, c) => Math.imul(31, h) + c.charCodeAt(0) | 0, 0)) % 9999;
}

// ═══════════════════════════════════════════════
// GOOGLE PLACES IMAGE FETCHER
// ═══════════════════════════════════════════════

/**
 * Resolve a Google Place photo reference to a real CDN URL.
 * Google's Place Photo endpoint returns HTTP 302 → actual image on lh3.googleusercontent.com.
 * We capture that Location header (no image downloaded) so the API key never reaches the client.
 */
async function resolvePhotoRef(photoRef) {
    if (!MAPS_API_KEY) return null;
    const apiUrl = `https://maps.googleapis.com/maps/api/place/photo` +
                   `?maxwidth=800&photoreference=${encodeURIComponent(photoRef)}&key=${MAPS_API_KEY}`;
    try {
        // maxRedirects:0 makes axios throw on the 302 instead of following it
        await axios.get(apiUrl, { maxRedirects: 0, timeout: 5000 });
        return apiUrl; // rare: direct 200, return as-is
    } catch (e) {
        const loc = e.response?.headers?.location;
        if (loc) return loc; // CDN URL — safe to expose, contains no API key
        return null;
    }
}

/**
 * Fetch up to `count` real place photos via the Google Places API (Legacy).
 * Pipeline:
 *   1. Find Place from Text  → place_id
 *   2. Place Details          → photos[] (photo_reference tokens)
 *   3. Place Photo            → resolve each ref to a CDN URL
 * Results are cached in imageCache so repeated calls for the same place are free.
 */
async function getPlaceImages(placeName, count = 3) {
    if (!MAPS_API_KEY) return [];

    const cacheKey = `gplaces::${placeName.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()}`;
    if (imageCache.has(cacheKey)) return imageCache.get(cacheKey);

    try {
        // ── Step 1: Find Place from Text ──────────────────────────────────────
        const findRes = await axios.get(
            'https://maps.googleapis.com/maps/api/place/findplacefromtext/json',
            {
                params: {
                    input:     placeName,
                    inputtype: 'textquery',
                    fields:    'place_id,name',
                    key:       MAPS_API_KEY
                },
                timeout: 6000
            }
        );
        const placeId = findRes.data.candidates?.[0]?.place_id;
        if (!placeId) throw new Error(`No place_id found for: "${placeName}"`);

        // ── Step 2: Place Details → photo references ───────────────────────
        const detailRes = await axios.get(
            'https://maps.googleapis.com/maps/api/place/details/json',
            {
                params: {
                    place_id: placeId,
                    fields:   'photos',
                    key:      MAPS_API_KEY
                },
                timeout: 6000
            }
        );
        const photos = detailRes.data.result?.photos || [];
        if (!photos.length) throw new Error(`No photos available for place_id: ${placeId}`);

        // ── Step 3: Resolve refs → CDN URLs (try count*2 in case some fail) ──
        const urls = [];
        for (const photo of photos.slice(0, count * 2)) {
            if (urls.length >= count) break;
            const url = await resolvePhotoRef(photo.photo_reference);
            if (url) urls.push(url);
        }
        if (!urls.length) throw new Error('All photo refs failed to resolve');

        // ── Cache the resolved URLs ────────────────────────────────────────
        if (imageCache.size >= 600) imageCache.delete(imageCache.keys().next().value);
        imageCache.set(cacheKey, urls);
        console.log(`✅ Google Places images cached for "${placeName}" (${urls.length} photos)`);
        return urls;

    } catch (e) {
        console.error(`getPlaceImages("${placeName}"):`, e.message);
        return []; // caller falls through to AI fallback
    }
}

// ── REGION MAP — used to derive a smart trip title for multi-city trips ──────
const REGION_MAP = {
    // Europe
    Paris:'Europe', Rome:'Europe', Amsterdam:'Europe', Zurich:'Europe', Vienna:'Europe',
    Prague:'Europe', Berlin:'Europe', Barcelona:'Europe', Madrid:'Europe', London:'Europe',
    Milan:'Europe', Istanbul:'Europe', Athens:'Europe', Lisbon:'Europe', Budapest:'Europe',
    Warsaw:'Europe', Brussels:'Europe', Geneva:'Europe', Nice:'Europe', Florence:'Europe',
    Venice:'Europe', Dubrovnik:'Europe', Santorini:'Europe', Porto:'Europe', Copenhagen:'Europe',
    Stockholm:'Europe', Oslo:'Europe', Helsinki:'Europe', Dublin:'Europe', Reykjavik:'Europe',
    // Japan
    Tokyo:'Japan', Kyoto:'Japan', Osaka:'Japan', Hiroshima:'Japan',
    Nara:'Japan', Sapporo:'Japan', Fukuoka:'Japan', Hakone:'Japan',
    // Thailand
    Bangkok:'Thailand', Phuket:'Thailand', Krabi:'Thailand', 'Chiang Mai':'Thailand',
    'Koh Samui':'Thailand', Pattaya:'Thailand', Ayutthaya:'Thailand',
    // UAE
    Dubai:'UAE', 'Abu Dhabi':'UAE', Sharjah:'UAE',
    // Konkan (Maharashtra coast)
    Alibaug:'Konkan', Ganpatipule:'Konkan', Ratnagiri:'Konkan', Tarkarli:'Konkan',
    Dapoli:'Konkan', Murud:'Konkan', Harihareshwar:'Konkan', Malvan:'Konkan', Vengurla:'Konkan',
    // Himachal Pradesh
    Manali:'Himachal Pradesh', Shimla:'Himachal Pradesh', Kasol:'Himachal Pradesh',
    Dharamshala:'Himachal Pradesh', 'McLeod Ganj':'Himachal Pradesh', Dalhousie:'Himachal Pradesh',
    Spiti:'Himachal Pradesh', Kufri:'Himachal Pradesh', Chail:'Himachal Pradesh',
    // Rajasthan
    Jaipur:'Rajasthan', Udaipur:'Rajasthan', Jodhpur:'Rajasthan', Jaisalmer:'Rajasthan',
    Pushkar:'Rajasthan', Bikaner:'Rajasthan', Ajmer:'Rajasthan', 'Mount Abu':'Rajasthan',
    // Kerala
    Kochi:'Kerala', Munnar:'Kerala', Alleppey:'Kerala', Thekkady:'Kerala',
    Wayanad:'Kerala', Kovalam:'Kerala', Varkala:'Kerala', Kumarakom:'Kerala', Thrissur:'Kerala',
    // Goa
    Goa:'Goa', 'North Goa':'Goa', 'South Goa':'Goa', Panaji:'Goa', Calangute:'Goa', Anjuna:'Goa',
    // Uttarakhand
    Rishikesh:'Uttarakhand', Haridwar:'Uttarakhand', Mussoorie:'Uttarakhand',
    Nainital:'Uttarakhand', 'Jim Corbett':'Uttarakhand', Auli:'Uttarakhand', Chopta:'Uttarakhand',
    // Northeast India
    Shillong:'Northeast India', Meghalaya:'Northeast India', Kaziranga:'Northeast India',
    Cherrapunji:'Northeast India', Gangtok:'Northeast India', Darjeeling:'Northeast India', Sikkim:'Northeast India',
    // Bali / Indonesia
    Bali:'Bali', Ubud:'Bali', Seminyak:'Bali', Kuta:'Bali', 'Nusa Penida':'Bali', Canggu:'Bali',
    // Southeast Asia
    Singapore:'Singapore',
    'Kuala Lumpur':'Malaysia', Langkawi:'Malaysia', Penang:'Malaysia',
    'Ho Chi Minh':'Vietnam', Hanoi:'Vietnam', 'Hoi An':'Vietnam', 'Ha Long':'Vietnam',
    'Siem Reap':'Cambodia', 'Phnom Penh':'Cambodia',
    Colombo:'Sri Lanka', Kandy:'Sri Lanka', Sigiriya:'Sri Lanka', Galle:'Sri Lanka',
    Maldives:'Maldives', Male:'Maldives',
    // Middle East / Africa
    Doha:'Qatar', Riyadh:'Saudi Arabia', Cairo:'Egypt', Marrakech:'Morocco', Casablanca:'Morocco',
};

// Returns a region name when ALL cities in the array share the same region; else null.
function detectRegion(cityNames) {
    if (!cityNames || cityNames.length < 2) return null;
    const regions = cityNames.map(c => REGION_MAP[c] || REGION_MAP[(c || '').trim()]);
    if (regions.every(r => r && r === regions[0])) return regions[0];
    return null;
}

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

    // First and last city for multi-city route (used in flight prompt + meta)
    const firstCity = isMultiCity && parsedCities.length > 0 ? parsedCities[0].city : effectiveDestination;
    const lastCity  = isMultiCity && parsedCities.length > 0 ? parsedCities[parsedCities.length - 1].city : effectiveDestination;

    // ── Budget reference (realistic baseline costs) ────────────────────────────
    const budgetRef = calculateBudgetReference(effectiveDestination, effectiveFrom, totalDays, style);
    const fmtINR = v => v.toLocaleString('en-IN');

    // ── Flight / Transport prompt section ─────────────────────────────────────
    // Multi-city: show departure (Home→FirstCity) + return (LastCity→Home) structure.
    // Single-city: show 3 options (cheapest / fastest / best_value) with outbound+inbound.
    // Gemini sets travel_mode → "flight" (any leg > 500 km or international) or
    //                          "ground" (all legs ≤ 500 km domestic; bus/train/cab/ferry).
    // If travel_mode = "ground": set flights:[] and fill transport_legs instead.
    const interCityLegsExample = isMultiCity && parsedCities.length > 1
        ? parsedCities.slice(0, -1).map((c, i) =>
            `{"from":"${c.city}","to":"${parsedCities[i + 1].city}","mode":"Bus/Train/Cab/Ferry","duration":"Xh Ym","price":"₹XXX","frequency":"Every X hrs or On demand"}`)
        : [];

    const flightPromptSection = isMultiCity
        ? `"travel_mode": "flight",
  "flights": [
    {"type":"departure","categoryLabel":"✈️ Departure Flight","from":"${effectiveFrom}","to":"${firstCity}","airline":"Real airline for this route","code":"FL-001","price":"₹XXXXX","outbound":{"time":"10:00 AM → 02:30 PM","duration":"Xh Ym","stops":"Non-stop or X stop(s)"}},
    {"type":"return","categoryLabel":"✈️ Return Flight","from":"${lastCity}","to":"${effectiveFrom}","airline":"Real airline for this route","code":"FL-002","price":"₹XXXXX","outbound":{"time":"11:00 AM → 03:30 PM","duration":"Xh Ym","stops":"Non-stop or X stop(s)"}}
  ],
  "transport_legs": [
    {"from":"${effectiveFrom}","to":"${firstCity}","mode":"Bus/Train/Cab/Ferry","duration":"Xh Ym","price":"₹XXX","frequency":"Every X hrs or On demand"},
    ${interCityLegsExample.join(',\n    ')}${interCityLegsExample.length ? ',' : ''}
    {"from":"${lastCity}","to":"${effectiveFrom}","mode":"Bus/Train/Cab/Ferry","duration":"Xh Ym","price":"₹XXX","frequency":"Every X hrs or On demand"}
  ],`
        : `"travel_mode": "flight",
  "flights": [
    {"category":"cheapest","categoryLabel":"💸 Cheapest Option","from":"${effectiveFrom}","to":"${effectiveDestination}","airline":"Real Airline","code":"FL-123","price":"₹8500","outbound":{"time":"06:00 AM → 08:30 AM","duration":"2h 30m","stops":"1 Stop"},"inbound":{"time":"08:00 PM → 10:30 PM","duration":"2h 30m","stops":"1 Stop"}},
    {"category":"fastest","categoryLabel":"⚡ Fastest Route","from":"${effectiveFrom}","to":"${effectiveDestination}","airline":"Different Airline","code":"FL-456","price":"₹12000","outbound":{"time":"10:00 AM → 12:00 PM","duration":"2h 00m","stops":"Non-stop"},"inbound":{"time":"06:00 PM → 08:00 PM","duration":"2h 00m","stops":"Non-stop"}},
    {"category":"best_value","categoryLabel":"⭐ Best Value","from":"${effectiveFrom}","to":"${effectiveDestination}","airline":"Third Airline","code":"FL-789","price":"₹10000","outbound":{"time":"08:00 AM → 10:30 AM","duration":"2h 30m","stops":"Non-stop"},"inbound":{"time":"07:00 PM → 09:30 PM","duration":"2h 30m","stops":"Non-stop"}}
  ],
  "transport_legs": [
    {"from":"${effectiveFrom}","to":"${effectiveDestination}","mode":"Bus/Train/Cab","duration":"Xh Ym","price":"₹XXX","frequency":"Every X hrs"}
  ],`;

    // ── Hotels prompt section — single flat array for single-city,
    //    city-keyed object for multi-city so Gemini returns hotels per city.
    const hotelsPromptSection = isMultiCity && parsedCities.length > 0
        ? `"hotels_by_city": {
${parsedCities.map(c => `    "${c.city}": [
      {"category":"budget","categoryLabel":"🎒 Budget Stay","name":"Real budget hotel name in ${c.city}","rating":"3.0★","price":"₹XXXX/night","address":"Budget area, ${c.city}","amenities":["WiFi","AC","Breakfast"]},
      {"category":"mid","categoryLabel":"🏙️ Mid-Range","name":"Real mid-range hotel name in ${c.city}","rating":"4.0★","price":"₹XXXX/night","address":"Central ${c.city}","amenities":["WiFi","Pool","Restaurant","Gym"]},
      {"category":"luxury","categoryLabel":"👑 Luxury","name":"Real luxury hotel name in ${c.city}","rating":"5.0★","price":"₹XXXX/night","address":"Premium area, ${c.city}","amenities":["WiFi","Infinity Pool","Spa","Fine Dining","Concierge"]}
    ]`).join(',\n')}
  },`
        : `"hotels": [
    {"category":"budget","categoryLabel":"🎒 Budget Stay","name":"Real Budget Hotel in ${effectiveDestination}","rating":"3.0★","price":"₹1500/night","address":"Budget Area, ${effectiveDestination}","amenities":["WiFi","AC","Breakfast"]},
    {"category":"mid","categoryLabel":"🏙️ Mid-Range","name":"Real Mid Hotel in ${effectiveDestination}","rating":"4.0★","price":"₹4500/night","address":"Central Area, ${effectiveDestination}","amenities":["WiFi","Pool","Restaurant","Gym"]},
    {"category":"luxury","categoryLabel":"👑 Luxury","name":"Real Luxury Hotel in ${effectiveDestination}","rating":"5.0★","price":"₹12000/night","address":"Premium Area, ${effectiveDestination}","amenities":["WiFi","Infinity Pool","Spa","Fine Dining","Concierge"]}
  ],`;

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
- Interests: ${interestsList} | Days: ${totalDays} | Date: ${date}
- Day Plan: ${itineraryInstruction}

BUDGET CALCULATION INSTRUCTIONS:
Calculate REALISTIC average travel costs for ${destDisplay}. Do NOT underestimate.
Use these reference baseline costs (${budgetRef.region} region, ${travelStyle} style, ${totalDays} days) as MINIMUMS:
- Round-trip flights from ${effectiveFrom}: ₹${fmtINR(budgetRef.flights)}
- Hotels (${totalDays} nights): ₹${fmtINR(budgetRef.hotels)}
- Food (${totalDays} days): ₹${fmtINR(budgetRef.food)}
- Local transport: ₹${fmtINR(budgetRef.transport)}
- Activities/attractions: ₹${fmtINR(budgetRef.activities)}
- Visa: ₹${fmtINR(budgetRef.visa)}
- Travel insurance: ₹${fmtINR(budgetRef.insurance)}
- Miscellaneous (12% buffer): ₹${fmtINR(budgetRef.misc)}
These are baselines — adjust HIGHER for expensive cities (Paris, Tokyo, NYC, Dubai, Zurich, London).
Adjust LOWER only for genuinely cheaper destinations. Always be realistic.

CRITICAL RULES:
1. Output EXACTLY ${totalDays} day objects in "itinerary" array.
2. Single-city: return "hotels" array with EXACTLY 3 options (budget/mid/luxury). Multi-city: return "hotels_by_city" object with EXACTLY 3 hotel options per city (budget/mid/luxury for each city).
3. TRAVEL MODE: analyse the route and set "travel_mode" to "flight" or "ground".
   - "flight" if any single leg exceeds ~500 km OR crosses an international border.
   - "ground" if ALL legs are short-haul domestic (≤ ~500 km), best covered by bus/train/cab/ferry.
   If "flight": populate the flights array with real airline data; set transport_legs: [].
   If "ground": set flights: []; populate transport_legs — one object per leg — with realistic mode/price/duration.
   Multi-city flights show ONLY departure (${effectiveFrom}→${firstCity}) + return (${lastCity}→${effectiveFrom}); NOT 3 options.
   Single-city flights show 3 options (cheapest / fastest / best_value) each with outbound + inbound.
4. Tailor places based on interests.
5. All hotel/transport/airline names MUST be realistic for the actual route.
6. For multi-city trips, label day themes with the city name.

Return ONLY this JSON (no markdown, no extra text):
{
  ${flightPromptSection}
  ${hotelsPromptSection}
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
    "flights": "₹${fmtINR(budgetRef.flights)}",
    "hotels": "₹${fmtINR(budgetRef.hotels)}",
    "food": "₹${fmtINR(budgetRef.food)}",
    "transport": "₹${fmtINR(budgetRef.transport)}",
    "activities": "₹${fmtINR(budgetRef.activities)}",
    "visa": "₹${fmtINR(budgetRef.visa)}",
    "insurance": "₹${fmtINR(budgetRef.insurance)}",
    "misc": "₹${fmtINR(budgetRef.misc)}",
    "budget_total": "₹${fmtINR(budgetRef.budget_total)}",
    "midrange_total": "₹${fmtINR(budgetRef.midrange_total)}",
    "luxury_total": "₹${fmtINR(budgetRef.luxury_total)}"
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
  "totalEstimatedCost": "₹${fmtINR(budgetRef.total)}"
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

        // ── Post-process budget: ensure all 8 categories + totals exist ──
        if (data.budget_breakdown) {
            const bd = data.budget_breakdown;
            const parseINR = v => parseInt(String(v || '0').replace(/[₹,\s]/g, '')) || 0;
            const toINR = v => '₹' + v.toLocaleString('en-IN');
            if (!bd.visa || bd.visa === '—') bd.visa = toINR(budgetRef.visa);
            if (!bd.insurance || bd.insurance === '—') bd.insurance = toINR(budgetRef.insurance);
            if (!bd.misc || bd.misc === '—') {
                const sub = parseINR(bd.flights) + parseINR(bd.hotels) + parseINR(bd.food) + parseINR(bd.transport) + parseINR(bd.activities) + parseINR(bd.visa) + parseINR(bd.insurance);
                bd.misc = toINR(Math.round(sub * 0.12));
            }
            // Ensure tier totals exist
            if (!bd.budget_total) bd.budget_total = toINR(budgetRef.budget_total);
            if (!bd.midrange_total) bd.midrange_total = toINR(budgetRef.midrange_total);
            if (!bd.luxury_total) bd.luxury_total = toINR(budgetRef.luxury_total);
            // Recalculate totalEstimatedCost from actual breakdown
            const total = parseINR(bd.flights) + parseINR(bd.hotels) + parseINR(bd.food) + parseINR(bd.transport) + parseINR(bd.activities) + parseINR(bd.visa) + parseINR(bd.insurance) + parseINR(bd.misc);
            data.totalEstimatedCost = toINR(total);
        } else {
            // Gemini didn't return budget — use our calculated reference
            const toINR = v => '₹' + v.toLocaleString('en-IN');
            data.budget_breakdown = {
                flights: toINR(budgetRef.flights), hotels: toINR(budgetRef.hotels), food: toINR(budgetRef.food),
                transport: toINR(budgetRef.transport), activities: toINR(budgetRef.activities), visa: toINR(budgetRef.visa),
                insurance: toINR(budgetRef.insurance), misc: toINR(budgetRef.misc),
                budget_total: toINR(budgetRef.budget_total), midrange_total: toINR(budgetRef.midrange_total), luxury_total: toINR(budgetRef.luxury_total)
            };
            data.totalEstimatedCost = toINR(budgetRef.total);
        }

        // Generate unique Trip ID and store itinerary for chatbot access
        const tripId = generateTripId();
        const regionName = detectRegion(
            isMultiCity && parsedCities.length > 1
                ? parsedCities.map(c => c.city)
                : [effectiveDestination]
        );
        data.meta = {
            tripId:        tripId,
            originCode:    getIATACode(effectiveFrom),
            destCode:      getIATACode(effectiveDestination),
            firstCityCode: getIATACode(firstCity),
            lastCityCode:  getIATACode(lastCity),
            firstCity,
            lastCity,
            isMultiCity,
            cities:        parsedCities,
            travelMode:    data.travel_mode || 'flight',
            tripTitle:     regionName || firstCity || effectiveDestination
        };

        // Store trip for chatbot access (evict oldest if over 500)
        if (trips.size >= 500) {
            const firstKey = trips.keys().next().value;
            trips.delete(firstKey);
        }
        trips.set(tripId, data);

        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify(data));
    } catch (error) {
        console.error("Gemini Error:", error);
        res.status(500).json({ error: "Error generating itinerary. Please try again." });
    }
});

// ═══════════════════════════════════════════════
// 2. TRIP RETRIEVAL
// ═══════════════════════════════════════════════
app.get("/trip/:tripId", (req, res) => {
    const { tripId } = req.params;
    const trip = trips.get(tripId);
    if (!trip) return res.status(404).json({ error: "Trip not found." });
    res.json(trip);
});

// ═══════════════════════════════════════════════
// 3. AI CHATBOT
// ═══════════════════════════════════════════════
app.post("/chat", async (req, res) => {
    if (!genAI) return res.status(500).json({ error: "Gemini API key is not configured." });
    const { message, destination, context, tripId } = req.body;
    if (!message) return res.status(400).json({ error: "No message provided." });
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // Build rich context from stored trip if tripId provided
        let tripContext = context || 'User is planning a trip.';
        if (tripId && trips.has(tripId)) {
            tripContext = buildTripContext(trips.get(tripId));
        }

        const chatPrompt = `You are SmartTripPlanner AI, a friendly AI travel assistant.
You have full access to the user's trip itinerary. Use the details below to give precise, helpful answers.
Trip Context:
${tripContext}

Answer concisely (max 3-4 sentences). Use emojis sparingly. If asked about specific days, hotels, costs, or places, refer directly to the itinerary above.
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
    const { email, destination: rawDestination, days, from: rawFrom, style, budget, travelDate, itinerary, totalCost } = req.body;
    const destination = rawDestination || 'Unknown';
    const from        = rawFrom        || 'Unknown';
    if (!email || !rawDestination) return res.status(400).json({ error: "Email and destination required." });
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
<title>Your SmartTripPlanner AI Itinerary</title></head>
<body style="margin:0;padding:0;background-color:#0d1117;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0d1117;">
    <tr><td align="center" style="padding:28px 12px;">
      <table width="600" cellpadding="0" cellspacing="0" border="0"
        style="max-width:600px;width:100%;background-color:#0a0f1a;border-radius:16px;overflow:hidden;border:1px solid rgba(212,167,106,0.15);">
        <tr>
          <td style="background:linear-gradient(135deg,#0a0f1a 0%,#1a2235 100%);padding:36px 40px 28px;text-align:center;border-bottom:1px solid rgba(212,167,106,0.18);">
            <div style="font-family:Georgia,serif;font-size:13px;letter-spacing:0.22em;text-transform:uppercase;color:#d4a76a;margin-bottom:14px;">✈ SmartTripPlanner AI</div>
            <h1 style="font-family:Georgia,serif;color:#f5f0e8;font-size:30px;font-weight:300;margin:0 0 10px;line-height:1.2;">Your Trip to ${destination}</h1>
            <p style="color:rgba(245,240,232,0.48);font-size:13px;margin:0;">${days} Days &nbsp;·&nbsp; ${from} → ${destination} &nbsp;·&nbsp; ${tripStyle} Style</p>
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
            <p style="font-size:11px;color:rgba(245,240,232,0.38);margin:0;">Curated by SmartTripPlanner AI based on your preferences</p>
          </td>
        </tr>
        ${dayCardsHtml}
        <tr><td style="padding:4px 0;"></td></tr>
        <tr>
          <td style="padding:28px 40px 24px;text-align:center;border-top:1px solid rgba(255,255,255,0.06);">
            <p style="color:rgba(245,240,232,0.5);font-size:14px;margin:0 0 18px;line-height:1.6;">Want to explore more destinations or tweak this plan?</p>
            <a href="https://smarttripplannerai.netlify.app/" style="display:inline-block;background:linear-gradient(135deg,#d4a76a,#c8941a);color:#0a0f1a;text-decoration:none;padding:13px 30px;border-radius:50px;font-size:13px;font-weight:700;letter-spacing:0.06em;">✨ Plan Another Trip</a>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 40px 22px;background:#050a12;text-align:center;">
            <p style="color:rgba(245,240,232,0.22);font-size:11px;margin:0;line-height:1.7;">
              Generated by <strong style="color:rgba(212,167,106,0.5);">SmartTripPlanner AI</strong> — Powered by SmartTripPlanner AI<br>
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
            sender: { email: EMAIL_USER, name: "SmartTripPlanner AI" },
            to: [{ email }],
            subject: `✈️ Your ${days}-Day ${destination} Itinerary — SmartTripPlanner AI`,
            htmlContent
        }, {
            headers: { 'accept': 'application/json', 'api-key': BREVO_API_KEY, 'content-type': 'application/json' },
            timeout: 10000   // 10 s — prevents Render from hanging and returning 502
        });
        res.json({ success: true });
    } catch(e) {
        // Log the full Brevo error body so env-var / API-key issues are visible in Render logs
        const errData = e.response?.data;
        console.error("Brevo Email error — HTTP status:", e.response?.status);
        console.error("Brevo response body:", JSON.stringify(errData));
        console.error("Brevo raw message:", e.message);
        res.status(500).json({ error: "Email send failed.", detail: errData || e.message });
    }
});

// ═══════════════════════════════════════════════
// 6. IMAGE FETCHER  (Google Places → AI fallback, cached)
// ═══════════════════════════════════════════════
app.get("/get-image", async (req, res) => {
    const { query, type } = req.query;
    if (!query) return res.json({ imageUrl: 'https://placehold.co/800x600/1a2235/d4a76a?text=Travel' });

    const cleanQuery = query.replace(/[^a-zA-Z0-9 ]/g, "").trim();
    const cacheKey   = `${type || 'place'}::${cleanQuery.toLowerCase()}`;

    // ── 1. Cache hit — skip all external calls ──────────────────────────────
    if (imageCache.has(cacheKey)) {
        const cached = imageCache.get(cacheKey);
        return res.json({ imageUrl: Array.isArray(cached) ? cached[0] : cached });
    }

    const ok = (url) => { cacheSet(cacheKey, url); return res.json({ imageUrl: url }); };

    try {
        // ── 2. Google Places API — real, accurate place photos ───────────────
        if (MAPS_API_KEY) {
            const photos = await getPlaceImages(cleanQuery);
            if (photos.length) return ok(photos[0]);
        }

        // ── 3. Pollinations.ai AI fallback (no key required) ─────────────────
        // Used when Google Places returns no results (very obscure places).
        const safePlace = cleanQuery.split(' ').slice(0, 6).join(' ');
        const prompt = type === 'hotel'
            ? `Professional architectural photography of ${safePlace} hotel, grand exterior facade, no people, wide angle, golden hour, ultra high quality`
            : `Professional travel photography of ${safePlace}, iconic scenic landmark, wide angle, no people, no tourists, golden hour, ultra high quality`;
        const negPrompt = 'people,person,man,woman,face,crowd,tourist,group,nude,blurry,low quality,watermark';
        const aiUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
                      `?width=800&height=600&nologo=true` +
                      `&negative=${encodeURIComponent(negPrompt)}` +
                      `&seed=${strSeed(cleanQuery)}&model=flux`;
        return ok(aiUrl);

    } catch (err) {
        console.error('/get-image error:', err.message);
        // Last resort — Picsum landscape/architecture seed (never portraits)
        const seed = cleanQuery.replace(/\s+/g, '-').toLowerCase().substring(0, 30);
        return res.json({ imageUrl: `https://picsum.photos/seed/${encodeURIComponent(seed)}/800/600` });
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
// 8. CONTACT FORM (sends email via Brevo)
// ═══════════════════════════════════════════════
app.post("/contact", async (req, res) => {
    const { name, email, subject, message } = req.body;
    if (!name || !email || !message) return res.status(400).json({ error: "Name, email, and message are required." });
    if (!BREVO_API_KEY || !EMAIL_USER) return res.status(500).json({ error: "Email API not configured." });

    const htmlContent = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#0d1117;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0d1117;">
    <tr><td align="center" style="padding:28px 12px;">
      <table width="580" cellpadding="0" cellspacing="0" border="0"
        style="max-width:580px;width:100%;background:#0a0f1a;border-radius:16px;overflow:hidden;border:1px solid rgba(212,167,106,0.15);">
        <tr>
          <td style="padding:28px 32px 20px;background:linear-gradient(135deg,#0a0f1a,#1a2235);border-bottom:1px solid rgba(212,167,106,0.15);">
            <p style="margin:0;font-family:Georgia,serif;font-size:22px;color:#d4a76a;font-weight:600;">✈ SmartTripPlanner AI</p>
            <p style="margin:6px 0 0;font-size:12px;color:rgba(245,240,232,0.4);">New Contact Form Submission</p>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
                <span style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:rgba(245,240,232,0.35);">From</span><br>
                <span style="font-size:15px;color:#f5f0e8;">${name}</span>
                <span style="font-size:13px;color:rgba(212,167,106,0.8);margin-left:8px;">&lt;${email}&gt;</span>
              </td></tr>
              <tr><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
                <span style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:rgba(245,240,232,0.35);">Subject</span><br>
                <span style="font-size:15px;color:#f5f0e8;">${subject || '(no subject)'}</span>
              </td></tr>
              <tr><td style="padding:16px 0 8px;">
                <span style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:rgba(245,240,232,0.35);">Message</span><br>
                <div style="margin-top:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:16px 18px;">
                  <p style="font-size:14px;color:rgba(245,240,232,0.82);line-height:1.75;margin:0;white-space:pre-wrap;">${message.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>
                </div>
              </td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 32px 20px;background:#050a12;text-align:center;">
            <p style="color:rgba(245,240,232,0.22);font-size:11px;margin:0;">
              Sent via SmartTripPlanner AI Contact Form — <a href="https://smarttripplannerai.netlify.app" style="color:rgba(212,167,106,0.5);">smarttripplannerai.netlify.app</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

    try {
        await axios.post('https://api.brevo.com/v3/smtp/email', {
            sender: { email: EMAIL_USER, name: "SmartTripPlanner AI" },
            to: ADMIN_EMAILS.map(e => ({ email: e })),
            replyTo: { email, name },
            subject: `📩 Contact Form: ${subject || 'New Message'} — from ${name}`,
            htmlContent
        }, {
            headers: { 'accept': 'application/json', 'api-key': BREVO_API_KEY, 'content-type': 'application/json' },
            timeout: 10000
        });
        res.json({ success: true });
    } catch(e) {
        const errData = e.response?.data;
        console.error("Contact email error:", e.response?.status, JSON.stringify(errData));
        res.status(500).json({ error: "Failed to send message.", detail: errData || e.message });
    }
});

// ═══════════════════════════════════════════════
// 9. NEWSLETTER SUBSCRIPTION
// ═══════════════════════════════════════════════
const subscribers = [];   // in-memory subscriber list (resets on restart)

app.post("/newsletter", async (req, res) => {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: "Valid email address required." });
    }

    // Avoid duplicate subscriptions
    if (!subscribers.includes(email.toLowerCase())) {
        subscribers.push(email.toLowerCase());
    }

    // Notify admin (best-effort — don't fail the response if email errors)
    if (BREVO_API_KEY && EMAIL_USER) {
        try {
            await axios.post('https://api.brevo.com/v3/smtp/email', {
                sender: { email: EMAIL_USER, name: "SmartTripPlanner AI" },
                to: ADMIN_EMAILS.map(e => ({ email: e })),
                subject: `📬 New Newsletter Subscriber — ${email}`,
                htmlContent: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#0d1117;padding:32px;">
                  <div style="max-width:480px;margin:0 auto;background:#0a0f1a;border:1px solid rgba(212,167,106,0.2);border-radius:14px;padding:28px;">
                    <p style="font-family:Georgia,serif;font-size:20px;color:#d4a76a;margin:0 0 16px;">✈ New Newsletter Subscriber</p>
                    <p style="color:rgba(245,240,232,0.75);font-size:14px;margin:0 0 8px;"><strong style="color:#f5f0e8;">Email:</strong> ${email}</p>
                    <p style="color:rgba(245,240,232,0.75);font-size:14px;margin:0 0 8px;"><strong style="color:#f5f0e8;">Total subscribers:</strong> ${subscribers.length}</p>
                    <p style="color:rgba(245,240,232,0.4);font-size:11px;margin:16px 0 0;">SmartTripPlanner AI — smarttripplannerai.netlify.app</p>
                  </div>
                </body></html>`
            }, {
                headers: { 'accept': 'application/json', 'api-key': BREVO_API_KEY, 'content-type': 'application/json' },
                timeout: 8000
            });
        } catch(e) {
            console.error("Newsletter admin notification error:", e.message);
        }
    }

    res.json({ success: true, subscriberCount: subscribers.length });
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
    console.log(`✈  SmartTripPlanner AI Backend v3.0 running on Port ${PORT}`);
});
