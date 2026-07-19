// ===================================================================
// X-ray Originals Database — Shadowfax theme, single-page build.
// Plain HTML/CSS/JS, no server, no build step.
// ===================================================================

const ADMIN_PIN = "403403";
const STORAGE_KEY = "scanline_admin_config";

const DEFAULT_CONFIG = {
  sheetId: "177bzU6wRnqK1YfLHZTpYk3gfAuA7GQAZk40xGQrMdyo",
  imageLookupUrl: "",
  knownBrands: [
    "Apple", "Samsung", "OnePlus", "Xiaomi", "Redmi", "Realme", "Vivo",
    "Oppo", "Sony", "boAt", "Noise", "JBL", "Bose", "Garmin", "Fitbit",
    "Google", "Nothing", "Motorola", "Asus", "Lenovo", "Dell", "HP"
  ],
  categoryLabels: {
    mobile: "Mobiles",
    headphone: "Headphones",
    smartwatch: "Smartwatch",
    drone: "Drones",
    trimmer: "Trimmers",
    electronics: "Electronics",
    "power bank": "Power Banks"
  }
};

// ===================================================================
// Admin config
// ===================================================================

function getConfig() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return structuredClone(DEFAULT_CONFIG);
    const parsed = JSON.parse(stored);
    return {
     sheetId: parsed.sheetId || DEFAULT_CONFIG.sheetId,
      imageLookupUrl: typeof parsed.imageLookupUrl === "string" ? parsed.imageLookupUrl : DEFAULT_CONFIG.imageLookupUrl,
      knownBrands: Array.isArray(parsed.knownBrands) && parsed.knownBrands.length > 0
        ? parsed.knownBrands : DEFAULT_CONFIG.knownBrands,
      categoryLabels: parsed.categoryLabels && Object.keys(parsed.categoryLabels).length > 0
        ? parsed.categoryLabels : DEFAULT_CONFIG.categoryLabels
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

function saveConfig(config) { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); }
function resetConfig() { localStorage.removeItem(STORAGE_KEY); }

// ===================================================================
// Data pipeline
// ===================================================================

let productCache = null;
let productCacheTime = 0;
let productCacheSheetId = null;
const CACHE_MS = 60 * 1000;

function detectBrand(rawName, knownBrands) {
  const lower = rawName.toLowerCase();
  for (const brand of knownBrands) {
    if (lower.includes(brand.toLowerCase())) return brand;
  }
  return "Other";
}

function cleanProductName(rawName, categoryLabel) {
  if (!rawName) return categoryLabel || "Unknown product";

  let cleaned = rawName.replace(/\{[^}]*\}/g, " ");
  cleaned = cleaned.replace(/\b\d{6,}\b/g, " ");

  const skuMatches = cleaned.match(/\b[A-Z0-9]{4,}\/[A-Z0-9]{1,3}\b/g) || [];
  cleaned = cleaned.replace(/\b[A-Z0-9]{4,}\/[A-Z0-9]{1,3}\b/g, " ");

  cleaned = cleaned.replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(/\s\d{2,5}$/, "").trim();

  const words = cleaned.split(" ").filter(Boolean);
  const seen = new Set();
  const deduped = [];
  for (const w of words) {
    const key = w.toLowerCase();
    if (key.length > 2 && seen.has(key)) continue;
    seen.add(key);
    deduped.push(w);
  }
  cleaned = deduped.join(" ").trim();

  const meaningfulWords = cleaned.split(" ").filter((w) => w.length > 2);
  if (meaningfulWords.length <= 2 && categoryLabel) {
    const firstWord = cleaned.split(" ")[0] || "";
    const remainder = cleaned.slice(firstWord.length).trim();
    const sku = skuMatches[0] ? ` (${skuMatches[0]})` : "";
    return `${firstWord} ${categoryLabel}${remainder ? " - " + remainder : ""}${sku}`.trim();
  }

  return cleaned || rawName.trim();
}

function extractStorageOrColor(rawName) {
  const details = [];
  const storageMatch = rawName.match(/\b(\d{1,4}\s?GB|\d{1,2}\s?TB)\b/i);
  if (storageMatch) details.push(storageMatch[0].replace(/\s+/, " "));
  return details;
}

function driveFileId(driveLink) {
  if (!driveLink) return null;
  const match = driveLink.match(/\/d\/([a-zA-Z0-9_-]+)/) || driveLink.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function driveFolderId(driveLink) {
  if (!driveLink) return null;
  const match = driveLink.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function driveLinkToImageUrl(driveLink) {
  const id = driveFileId(driveLink);
  return id ? `https://drive.google.com/thumbnail?id=${id}&sz=w1000` : null;
}

// Builds a link straight to Drive's own search results, pre-filled with
// the AWB, scoped to the given folder if one was provided. This is the
// honest fallback for sheets whose "X-ray link" column points at a whole
// folder rather than one specific file (common in real workflows, since
// files just get dropped into one shared folder named by AWB) — there's
// no public, keyless way to look up "the file named X inside this folder"
// programmatically, so the practical fix is a one-click pre-filled search
// instead of leaving the operator to open the folder and search by hand.
function driveSearchUrl(awb, folderId) {
  if (!awb) return null;
  const query = encodeURIComponent(awb);
  if (folderId) {
    return `https://drive.google.com/drive/search?q=${query}%20parent:${folderId}`;
  }
  return `https://drive.google.com/drive/search?q=${query}`;
}

// Loads the sheet via Google's gviz/tq endpoint using a JSONP-style script
// tag instead of fetch(). This matters because docs.google.com does not
// send CORS headers on its CSV export endpoint, so a plain fetch() is
// blocked by the browser in every deployment, not just locally. Loading
// via a <script> tag sidesteps this entirely, since cross-origin scripts
// have never been subject to CORS the way fetch()/XHR are — that's the
// whole reason JSONP existed before CORS was invented.
function fetchSheetViaJsonp(sheetId, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const callbackName = `__gvizCallback_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const script = document.createElement("script");
    let settled = false;

    const cleanup = () => {
      delete window[callbackName];
      script.remove();
      clearTimeout(timer);
    };

    window[callbackName] = (response) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Sheet request timed out"));
    }, timeoutMs);

    script.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Sheet script failed to load"));
    };

    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=responseHandler:${callbackName}`;
    script.src = url;
    document.head.appendChild(script);
  });
}

// Converts the gviz response (Google's own JSON-like table format) into
// the same [headerRow, ...dataRows] shape parseCSV() would have produced,
// so the rest of the pipeline (rowsToProducts) doesn't need to change.
function gvizResponseToRows(response) {
  if (!response || response.status === "error" || !response.table) {
    throw new Error("Sheet returned an error or empty table");
  }
  const cols = response.table.cols.map((c) => c.label || c.id || "");
  const rows = response.table.rows.map((row) =>
    (row.c || []).map((cell) => (cell && cell.v != null ? String(cell.v) : ""))
  );
  return [cols, ...rows];
}

// A handful of exact header label strings. If a data row's cells match
// these almost verbatim, it's a stray duplicate header (e.g. someone
// pasted the header row again further down the sheet by accident) rather
// than a real product — skip it instead of treating literal column-label
// text as a product name, category, and link.
const HEADER_LOOKALIKE_VALUES = new Set([
  "x-ray_date", "x ray date", "date",
  "awb_number", "awb number", "awb",
  "x-ray_image", "x ray image", "x-ray link", "xray link", "image",
  "product_catagories", "product_category", "product category", "product catagories", "category", "categories",
  "product_name", "product name", "product _name", "name",
  "location"
]);

function looksLikeStrayHeaderRow(row, columnMap) {
  const indices = columnMap
    ? Object.values(columnMap)
    : row.map((_, i) => i);
  const cells = indices.map((i) => (row[i] || "").trim().toLowerCase());
  const nonEmptyCells = cells.filter(Boolean);
  if (nonEmptyCells.length === 0) return false;
  // If every non-empty cell in this row is itself a header label, it's a
  // duplicate header row, not real data.
  return nonEmptyCells.every((c) => HEADER_LOOKALIKE_VALUES.has(c));
}

// ===================================================================
// Column mapping is resolved by HEADER NAME, not fixed position.
//
// This is the fix for the recurring "I added rows and it broke" problem:
// column order isn't stable in practice — columns get reordered, someone
// inserts a new field, a duplicate/renamed header sneaks in, etc. Reading
// off fixed indices (r[0], r[1]...) silently reads the wrong field the
// moment the layout shifts, with no error, just wrong-looking data.
// Instead, the header row is scanned once per load and each known field
// (awb, image, category, name, ...) is matched to whichever column
// currently has a recognizable header for it. As long as the header text
// itself is roughly unchanged, new/reordered/deleted columns elsewhere in
// the sheet can't break this.
// ===================================================================

function normalizeHeaderKey(str) {
  return (str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const FIELD_HEADER_ALIASES = {
  date: ["xraydate", "date", "scandate"],
  awb: ["awbnumber", "awb", "awbno", "trackingnumber", "trackingid", "waybillnumber", "waybill"],
  image: ["xrayimage", "xraylink", "xrayimagelink", "xrayimageurl", "imagelink", "image", "scanimage"],
  category: ["productcatagories", "productcategories", "productcategory", "category", "categories"],
  name: ["productname", "name", "itemname", "productdescription", "description"],
  location: ["location", "dc", "facility", "warehouse"]
};

// Last-resort positions, matching the sheet's originally documented
// layout (X-ray_Date, Awb number, X-ray_image, Product_catagories,
// Product _name, Location). Only used for a field whose header text
// couldn't be matched by name at all.
const FALLBACK_COLUMN_POSITIONS = { date: 0, awb: 1, image: 2, category: 3, name: 4, location: 5 };

// Set by buildColumnMap on every load so the UI can warn if a critical
// field had to fall back to a guessed position instead of a matched
// header — a strong signal the sheet's header text changed.
let lastColumnMapUnmatchedFields = [];

function buildColumnMap(headerRow) {
  const map = {};
  (headerRow || []).forEach((rawHeader, idx) => {
    const normalized = normalizeHeaderKey(rawHeader);
    for (const [field, aliases] of Object.entries(FIELD_HEADER_ALIASES)) {
      if (map[field] === undefined && aliases.includes(normalized)) {
        map[field] = idx;
      }
    }
  });

  const unmatched = [];
  for (const field of Object.keys(FALLBACK_COLUMN_POSITIONS)) {
    if (map[field] === undefined) {
      unmatched.push(field);
      map[field] = FALLBACK_COLUMN_POSITIONS[field];
    }
  }
  lastColumnMapUnmatchedFields = unmatched;

  return map;
}

// Known messy/inconsistent category text seen in the sheet, mapped to the
// canonical key it should resolve to before label lookup. This is an
// explicit list rather than fuzzy "contains" matching on purpose — fuzzy
// matching could wrongly merge a future distinct category (e.g. a real
// "headphone stand" category) into an unrelated one just because it shares
// a word. Add new entries here as new sheet inconsistencies show up.
const CATEGORY_NORMALIZATION = {
  "apple headphone": "headphone",
  "apple headphones": "headphone",
  "headphones": "headphone",
  "mobiles": "mobile",
  "smartwatches": "smartwatch",
  "power banks": "power bank",
  "drones": "drone",
  "trimmers": "trimmer"
};

function titleCase(str) {
  if (!str) return str;
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeCategoryKey(rawCategory) {
  return CATEGORY_NORMALIZATION[rawCategory] || rawCategory;
}

function rowsToProducts(rows, config) {
  const headerRow = rows[0] || [];
  const columnMap = buildColumnMap(headerRow);

  // AWB is the field that determines whether a row is real data at all —
  // resolved by header name via columnMap, wherever that column actually
  // is this time, rather than assuming it's column B.
  const dataRows = rows
    .slice(1)
    .filter((r) => r[columnMap.awb] && r[columnMap.awb].trim())
    .filter((r) => !looksLikeStrayHeaderRow(r, columnMap));

  return dataRows.map((r) => {
    const awb = (r[columnMap.awb] || "").trim();
    const xrayLink = (r[columnMap.image] || "").trim();
    const rawCategory = normalizeCategoryKey((r[columnMap.category] || "").trim().toLowerCase());
    const rawName = (r[columnMap.name] || "").trim();

    const brand = detectBrand(rawName, config.knownBrands);
    const category = config.categoryLabels[rawCategory] || titleCase(rawCategory) || "Uncategorized";
    const cleanedName = cleanProductName(rawName, category);
    const details = extractStorageOrColor(rawName);

    const fileId = driveFileId(xrayLink);
    const folderId = driveFolderId(xrayLink);

    // If the sheet gives a specific file link, use it directly. If it's a
    // folder link (the common real-world case: one shared folder, files
    // named by AWB), there's no public way to resolve "the file named
    // this AWB" into an image URL without Drive API auth — so instead of
    // a dead link to the folder's root, point at a pre-filled Drive search
    // for this AWB inside that folder, which gets the operator to the
    // right file in one click instead of manually searching.
    const image = fileId ? driveLinkToImageUrl(xrayLink) : null;
    const sourceLink = fileId
      ? xrayLink
      : folderId
      ? driveSearchUrl(awb, folderId)
      : xrayLink;

    return {
      awb,
      productName: cleanedName,
      fullDetails: details.join(", "),
      category,
      categoryKey: rawCategory,
      brand,
      image,
      sourceLink,
      isFolderSearchLink: !fileId && !!folderId,
      driveFileId: fileId
    };
  });
}

const FALLBACK_ROWS = [
  ["awb_number", "product_name", "product_category", "X-ray link"],
  ["SF3201408623F", "Apple MWTY3ZM/A White 195949506123 headphone fallback row", "headphone", "https://drive.google.com/file/d/1-_3xE_oQJ6Shom7Xxw7djxkBuuiBLX2T/view?usp=sharing"],
  ["SF2016986091F", "Apple iPhone 16 MYEA3HN/A Pink 195949822193 128 GB", "mobile", "https://drive.google.com/file/d/12ro1hlY7_kZh7poEb9dWNagCwCKyuZrc/view?usp=sharing"],
  ["SF2948568422F", "Apple Watch SE 2 GPS 40mm Midnight Aluminium Ink Sport Loop", "smartwatch", "https://drive.google.com/file/d/15ViF3myDUu3SelfGGwRWl60ccBGRgY0T/view?usp=sharing"],
  ["SF2613662733F", "Apple iPhone 17 MG6K4HN/A White 195950643640 256 GB", "mobile", "https://drive.google.com/file/d/16XV2EZqhNFlx3b1E6YlWPu1b-3k7FYXF/view?usp=sharing"],
  ["SF2437847300F", "Apple iPhone 16 MYEA3HN/A Pink 195949822193 128 GB", "mobile", "https://drive.google.com/file/d/1AYhbPiXQI91Io8r3szIds7fuztJldKN_/view?usp=sharing"],
  ["SF2616351472F", "Apple iPhone 17 MG6M4HN/A Lavender 195950644043 256 GB", "mobile", "https://drive.google.com/file/d/1c7b8rTChvkQGa6_my8QZEXAJETjDyb4g/view?usp=sharing"],
  ["SF2616692840F", "Apple Watch SE 2 GPS 44mm Starlight Aluminium Sport Band", "smartwatch", "https://drive.google.com/file/d/1gA_K1dCDq2eIvCFs_SiIR9yBxG1XyjLQ/view?usp=sharing"],
  ["SF2017644657F", "Apple MWTY3ZM/A White 195949506123 headphone fallback row", "headphone", "https://drive.google.com/file/d/1itGcZITpF8KnPKIcuxFuw0XFVmmdaox3/view?usp=sharing"],
  ["SF2615266638F", "Apple MWTY3ZM/A White 195949506123 headphone fallback row", "headphone", "https://drive.google.com/file/d/1IX-2AJay0DLx5qcw0gT7TDLDotKRLdKw/view?usp=sharing"],
  ["SF2018250692F", "Apple Watch SE 2 GPS 40mm Midnight Aluminium Ink Sport Loop", "smartwatch", "https://drive.google.com/file/d/1JgQqwFOji59mb8vAE7m6fNZkrH8uAVkH/view?usp=sharing"],
  ["SF2613332374F", "Apple iPhone 17 MG6M4HN/A Lavender 195950644043 256 GB", "mobile", "https://drive.google.com/file/d/1pNTbuSLfC_ZG1EIHffGfmTrGmeZ9Nm6U/view?usp=sharing"],
  ["SF2437689855F", "Apple iPhone 17 MG6J4HN/A Black 195950643442 256 GB", "mobile", "https://drive.google.com/file/d/1qSVEcWZlXPYwrBIHXpRiq6vF5LH-MGek/view?usp=sharing"],
  ["SF2014864095F", "Apple iPhone 16 MYEC3HN/A Ultramarine 195949822377 128 GB", "mobile", "https://drive.google.com/file/d/1YLaXXCkpU-NWWISy2TT95wTUm1ecjq4t/view?usp=sharing"]
];

async function getProducts() {
  const config = getConfig();
  const now = Date.now();

  if (productCache && productCacheSheetId === config.sheetId && now - productCacheTime < CACHE_MS) {
    return rowsToProducts(productCache, config);
  }

  try {
    const response = await fetchSheetViaJsonp(config.sheetId);
    const rows = gvizResponseToRows(response);
    productCache = rows;
    productCacheTime = now;
    productCacheSheetId = config.sheetId;
    return rowsToProducts(rows, config);
  } catch (err) {
    console.error("Failed to load live sheet, using bundled fallback data:", err.message);
    return rowsToProducts(FALLBACK_ROWS, config);
  }
}

async function searchProducts(query) {
  const products = await getProducts();
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return products.filter((p) =>
    p.awb.toLowerCase().includes(q) ||
    p.productName.toLowerCase().includes(q) ||
    p.brand.toLowerCase().includes(q) ||
    p.category.toLowerCase().includes(q)
  );
}

async function getCategories() {
  const products = await getProducts();
  const map = new Map();
  for (const p of products) {
    if (!map.has(p.category)) map.set(p.category, new Set());
    map.get(p.category).add(p.brand);
  }
  return Array.from(map.entries()).map(([category, brands]) => ({
    category,
    brands: Array.from(brands).sort(),
    count: products.filter((p) => p.category === category).length
  }));
}

async function getProductsByCategory(category, brand) {
  const products = await getProducts();
  return products.filter((p) => p.category === category && (!brand || p.brand === brand));
}

// Electronics / Mobiles / Headphones are the highest-volume, highest-risk
// categories, so they're always shown first and in this fixed order.
// Everything else follows, ordered by how many items are in it — the
// categories with the most reference images to browse surface first.
const PRIORITY_CATEGORIES = ["Electronics", "Mobiles", "Headphones"];

function sortCategoriesForDisplay(categories) {
  const priorityLower = PRIORITY_CATEGORIES.map((c) => c.toLowerCase());
  const priority = new Array(PRIORITY_CATEGORIES.length).fill(null);
  const rest = [];

  for (const cat of categories) {
    const idx = priorityLower.indexOf(cat.category.toLowerCase());
    if (idx !== -1) {
      priority[idx] = cat;
    } else {
      rest.push(cat);
    }
  }

  rest.sort((a, b) => b.count - a.count);
  return [...priority.filter(Boolean), ...rest];
}

// Brand counts within a set of items, most common first — used to show
// "which brands make up this category" under priority category headers,
// since Electronics/Mobiles/Headphones especially mix many brands.
function brandCounts(items) {
  const counts = new Map();
  for (const item of items) {
    counts.set(item.brand, (counts.get(item.brand) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ===================================================================
// Honest match logic for upload / paste-link
//
// There is no AI here, so "find a similar image" by visual content is
// not something this can genuinely do. What it CAN do honestly:
//  - Paste a Drive link that's already in the database -> exact match
//    by file ID (a real database lookup, not visual guessing)
//  - Upload a file whose filename contains an AWB already in the
//    database -> exact match by AWB (matches how files are actually
//    named in the real workflow)
// If neither applies, say so plainly instead of pretending to find
// something close.
// ===================================================================

function extractAwbFromFilename(filename) {
  // AWBs in the sheet aren't a fixed shape: 1-2 leading letters, 8-12
  // digits, then 0-3 trailing letters (e.g. "R1672705903F",
  // "SF2612305533F", "SF3111532514NER"). The old 2-letter-prefix,
  // single-trailing-letter pattern silently truncated matches on the
  // newer AWB formats.
  const match = filename.match(/[A-Z]{1,2}\d{8,12}[A-Z]{0,3}/i);
  return match ? match[0].toUpperCase() : null;
}

async function findExactMatchByFilename(filename) {
  const awb = extractAwbFromFilename(filename);
  if (!awb) return { matched: false, reason: "no-awb-in-filename" };

  const products = await getProducts();
  const found = products.find((p) => p.awb.toUpperCase() === awb);
  return found
    ? { matched: true, products: [found], reason: "awb-filename-match" }
    : { matched: false, reason: "awb-not-found", attemptedAwb: awb };
}

async function findExactMatchByLink(link) {
  const id = driveFileId(link);
  if (!id) {
    return driveFolderId(link)
      ? { matched: false, reason: "folder-link-not-file" }
      : { matched: false, reason: "not-a-drive-link" };
  }

  const products = await getProducts();
  const found = products.find((p) => p.driveFileId === id);
  return found
    ? { matched: true, products: [found], reason: "drive-link-match" }
    : { matched: false, reason: "link-not-found" };
}

// ===================================================================
// Rendering helpers
// ===================================================================

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function buildImageFallback(product) {
  const fallback = document.createElement("div");
  fallback.className = "image-fallback";
  const span = document.createElement("span");
  span.textContent = "Image unavailable";
  fallback.appendChild(span);
  if (product.sourceLink) {
    const link = document.createElement("a");
    link.href = product.sourceLink;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.className = "fallback-link";
    link.textContent = product.isFolderSearchLink
      ? `Search "${product.awb}" in Drive`
      : "Open in Drive";
    fallback.appendChild(link);
  }
  return fallback;
}

function renderResultCard(product, options = {}) {
  const card = document.createElement("div");
  card.className = "card";

  const imageWrap = document.createElement("div");
  imageWrap.className = "image-wrap";

  if (options.matchBadge) {
    const badge = document.createElement("span");
    badge.className = "match-badge";
    badge.textContent = "EXACT MATCH";
    imageWrap.appendChild(badge);
  }

  if (product.image) {
    const img = document.createElement("img");
    img.src = product.image;
    img.alt = `X-ray reference image of ${product.productName}`;
    img.className = "card-image";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => {
      imageWrap.querySelector(".card-image")?.remove();
      imageWrap.querySelector(".card-image-actions")?.remove();
      imageWrap.appendChild(buildImageFallback(product));
    };
    imageWrap.appendChild(img);

    const actions = document.createElement("div");
    actions.className = "card-image-actions";

    const zoomBtn = document.createElement("button");
    zoomBtn.className = "icon-btn";
    zoomBtn.type = "button";
    zoomBtn.title = "View larger";
    zoomBtn.setAttribute("aria-label", "View larger");
    zoomBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5"/><line x1="11" y1="11" x2="14.5" y2="14.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="7" x2="9" y2="7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="7" y1="5" x2="7" y2="9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
    zoomBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openLightbox(product);
    });
    actions.appendChild(zoomBtn);

    const downloadBtn = document.createElement("button");
    downloadBtn.className = "icon-btn";
    downloadBtn.type = "button";
    downloadBtn.title = "Download image";
    downloadBtn.setAttribute("aria-label", "Download image");
    downloadBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2V10M8 10L5 7M8 10L11 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 11.5V12.5C2.5 13.0523 2.94772 13.5 3.5 13.5H12.5C13.0523 13.5 13.5 13.0523 13.5 12.5V11.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    downloadBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      downloadImage(product);
    });
    actions.appendChild(downloadBtn);

    imageWrap.appendChild(actions);

    // Clicking the image itself also opens the lightbox, since that's
    // the most discoverable interaction even without noticing the icons.
    img.addEventListener("click", () => openLightbox(product));

    const scanLine = document.createElement("div");
    scanLine.className = "scan-line";
    imageWrap.appendChild(scanLine);
    setTimeout(() => scanLine.remove(), 750);
  } else {
    imageWrap.appendChild(buildImageFallback(product));
  }

  card.appendChild(imageWrap);

  const info = document.createElement("div");
  info.className = "card-info";
  info.innerHTML = `
    <div class="name-row">
      <span class="card-name">${escapeHtml(product.productName)}</span>
      <span class="card-brand">${escapeHtml(product.brand)}</span>
    </div>
    <div class="meta-row">
      <span class="card-category">${escapeHtml(product.category)}</span>
      <span class="card-awb">${escapeHtml(product.awb)}</span>
    </div>
  `;
  card.appendChild(info);

  return card;
}

function renderGrid(container, products, options = {}) {
  container.innerHTML = "";
  if (products.length === 0) return;
  const grid = document.createElement("div");
  grid.className = "grid";
  products.forEach((p) => grid.appendChild(renderResultCard(p, options)));
  container.appendChild(grid);
}

// ===================================================================
// Image lightbox: zoom view + download
//
// Download note: Drive's thumbnail URLs are cross-origin and don't send
// permissive headers, so a plain <a download> often can't force a real
// file download — the browser just navigates to the image instead. The
// code below tries to fetch the image as a blob (which works when the
// browser allows it) to force a real download with a clean filename; if
// that's blocked, it falls back to opening the image in a new tab so the
// person can still save it manually (right-click > save image).
// ===================================================================

const lightboxOverlay = document.getElementById("lightbox-overlay");
const lightboxImage = document.getElementById("lightbox-image");
const lightboxName = document.getElementById("lightbox-name");
const lightboxAwb = document.getElementById("lightbox-awb");
const lightboxDownload = document.getElementById("lightbox-download");
const lightboxClose = document.getElementById("lightbox-close");

function openLightbox(product) {
  if (!product.image) return;
  lightboxImage.src = product.image;
  lightboxImage.alt = `X-ray reference image of ${product.productName}`;
  lightboxImage.classList.remove("zoomed");
  lightboxName.textContent = product.productName;
  lightboxAwb.textContent = product.awb;
  lightboxDownload.dataset.productAwb = product.awb;
  lightboxDownload.dataset.productImage = product.image;
  lightboxDownload.dataset.productName = product.productName;
  lightboxOverlay.hidden = false;
}

function closeLightbox() {
  lightboxOverlay.hidden = true;
  lightboxImage.removeAttribute("src");
  lightboxImage.classList.remove("zoomed");
}

lightboxClose.addEventListener("click", closeLightbox);
lightboxOverlay.addEventListener("click", (e) => {
  if (e.target === lightboxOverlay) closeLightbox();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !lightboxOverlay.hidden) closeLightbox();
});

lightboxImage.addEventListener("click", () => {
  lightboxImage.classList.toggle("zoomed");
});

function safeFilename(awb, productName) {
  const base = awb || productName || "xray-image";
  return base.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 60) + ".jpg";
}

async function downloadImage(product) {
  if (!product.image) return;
  await triggerDownload(product.image, safeFilename(product.awb, product.productName));
}

lightboxDownload.addEventListener("click", async (e) => {
  e.preventDefault();
  const { productImage, productAwb, productName } = lightboxDownload.dataset;
  if (!productImage) return;
  await triggerDownload(productImage, safeFilename(productAwb, productName));
});

async function triggerDownload(imageUrl, filename) {
  try {
    const res = await fetch(imageUrl, { referrerPolicy: "no-referrer" });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  } catch (err) {
    // Cross-origin fetch was blocked, or the image host doesn't allow it.
    // Fall back to just opening the image in a new tab so the person can
    // still save it manually, rather than failing silently.
    console.warn("Direct download blocked, opening image in a new tab instead:", err.message);
    window.open(imageUrl, "_blank", "noreferrer");
  }
}

// ===================================================================
// View state: which section is visible (search / match / browse)
// ===================================================================

const searchSection = document.getElementById("search-results-section");
const matchSection = document.getElementById("match-results-section");
const browseSection = document.getElementById("browse-section");
const matchBanner = document.getElementById("match-banner");

function showOnly(section) {
  searchSection.hidden = section !== "search";
  matchSection.hidden = section !== "match";
  browseSection.hidden = section !== "browse";
}

// ===================================================================
// Default view: browse library, grouped by category, shuffled order
// ===================================================================

function renderColumnMapWarning(container) {
  if (lastColumnMapUnmatchedFields.length === 0) return;
  const box = document.createElement("div");
  box.className = "diagnostic-banner";
  box.innerHTML = `
    <span class="diagnostic-title">Heads up: some columns were guessed</span>
    <span class="diagnostic-body">Couldn't confidently match a header for: ${escapeHtml(lastColumnMapUnmatchedFields.join(", "))}.
    Falling back to a default column position for ${lastColumnMapUnmatchedFields.length === 1 ? "it" : "them"}, which may be wrong if your sheet's layout changed.
    Check that the header row still reads X-ray_Date, Awb number, X-ray_image, Product_catagories, Product _name, Location (any order is fine, the text just needs to match).</span>
  `;
  container.appendChild(box);
}

async function loadBrowseDefault() {
  const browseGroups = document.getElementById("browse-groups");
  browseGroups.innerHTML = `<div class="status-text">Loading library…</div>`;

  const categories = sortCategoriesForDisplay(await getCategories());
  browseGroups.innerHTML = "";

  renderColumnMapWarning(browseGroups);

  for (const cat of categories) {
    const items = await getProductsByCategory(cat.category, null);
    const shuffled = shuffle(items);
    const isPriority = PRIORITY_CATEGORIES.some((p) => p.toLowerCase() === cat.category.toLowerCase());

    const block = document.createElement("div");
    block.className = "group-block";
    block.innerHTML = `
      <div class="group-header">
        <span class="group-title">${escapeHtml(cat.category)}</span>
        <span class="group-count">${cat.count}</span>
      </div>
    `;

    if (isPriority && cat.brands.length > 1) {
      const brandLine = document.createElement("div");
      brandLine.className = "group-brands";
      brandLine.textContent = brandCounts(items)
        .map(([brand, count]) => `${brand} ${count}`)
        .join(" · ");
      block.appendChild(brandLine);
    }

    const gridHolder = document.createElement("div");
    block.appendChild(gridHolder);
    renderGrid(gridHolder, shuffled);
    browseGroups.appendChild(block);
  }

  if (categories.length === 0) {
    browseGroups.innerHTML = `<div class="idle-state">No items in the library yet.</div>`;
    renderColumnMapWarning(browseGroups);
  }
}

// ===================================================================
// Sidebar: category + brand filters
// ===================================================================

let sidebarCategories = [];
let sidebarActiveCategory = null;
let sidebarActiveBrand = null;

async function loadSidebar() {
  sidebarCategories = sortCategoriesForDisplay(await getCategories());
  renderSidebar();
}

function renderSidebar() {
  const container = document.getElementById("sidebar-categories");
  container.innerHTML = "";

  const allBtn = document.createElement("button");
  allBtn.className = sidebarActiveCategory === null ? "cat-button cat-button-active" : "cat-button";
  allBtn.innerHTML = `<span>All categories</span>`;
  allBtn.addEventListener("click", () => selectSidebarCategory(null));
  container.appendChild(allBtn);

  sidebarCategories.forEach((c) => {
    const btn = document.createElement("button");
    btn.className = c.category === sidebarActiveCategory ? "cat-button cat-button-active" : "cat-button";
    btn.innerHTML = `<span>${escapeHtml(c.category)}</span><span class="count">${c.count}</span>`;
    btn.addEventListener("click", () => selectSidebarCategory(c.category));
    container.appendChild(btn);

    if (c.category === sidebarActiveCategory && c.brands.length > 0) {
      const brandRow = document.createElement("div");
      brandRow.className = "brand-row";

      const allBrandChip = document.createElement("button");
      allBrandChip.className = sidebarActiveBrand === null ? "brand-chip brand-chip-active" : "brand-chip";
      allBrandChip.textContent = "All brands";
      allBrandChip.addEventListener("click", (e) => { e.stopPropagation(); selectSidebarBrand(null); });
      brandRow.appendChild(allBrandChip);

      c.brands.forEach((b) => {
        const chip = document.createElement("button");
        chip.className = b === sidebarActiveBrand ? "brand-chip brand-chip-active" : "brand-chip";
        chip.textContent = b;
        chip.addEventListener("click", (e) => { e.stopPropagation(); selectSidebarBrand(b); });
        brandRow.appendChild(chip);
      });

      container.appendChild(brandRow);
    }
  });
}

async function renderCategoryResults(category, brand) {
  showOnly("browse");
  const browseGroups = document.getElementById("browse-groups");
  browseGroups.innerHTML = `<div class="status-text">Loading…</div>`;
  const items = await getProductsByCategory(category, brand);
  browseGroups.innerHTML = "";
  const block = document.createElement("div");
  block.className = "group-block";
  block.innerHTML = `<div class="group-header"><span class="group-title">${escapeHtml(category)}</span><span class="group-count">${items.length}</span></div>`;
  const gridHolder = document.createElement("div");
  block.appendChild(gridHolder);
  renderGrid(gridHolder, shuffle(items));
  browseGroups.appendChild(block);
}

async function selectSidebarCategory(category) {
  sidebarActiveCategory = category;
  sidebarActiveBrand = null;
  renderSidebar();
  clearMatchState();
  searchInput.value = "";

  if (category === null) {
    await loadBrowseDefault();
    showOnly("browse");
    return;
  }

  await renderCategoryResults(category, null);
}

async function selectSidebarBrand(brand) {
  sidebarActiveBrand = brand;
  renderSidebar();
  await renderCategoryResults(sidebarActiveCategory, brand);
}

// ===================================================================
// Search
// ===================================================================

const searchInput = document.getElementById("search-input");
let searchDebounce = null;

searchInput.addEventListener("input", (e) => {
  const value = e.target.value;
  clearTimeout(searchDebounce);

  if (!value.trim()) {
    showOnly("browse");
    return;
  }

  searchDebounce = setTimeout(async () => {
    showOnly("search");
    const resultsHolder = document.getElementById("search-results");
    resultsHolder.innerHTML = `<div class="status-text">Scanning library…</div>`;
    const results = await searchProducts(value);

    if (results.length === 0) {
      resultsHolder.innerHTML = `
        <div class="empty-state">
          <div class="empty-title">No match found</div>
          <div class="empty-body">Nothing in the library matches "${escapeHtml(value)}". Check the spelling, or browse by category using the sidebar.</div>
        </div>
      `;
      return;
    }
    renderGrid(resultsHolder, results);
  }, 250);
});

// ===================================================================
// Upload / paste-link: honest exact-match-only flow
// ===================================================================

const matchPreview = document.getElementById("match-preview");
const matchBannerSub = document.getElementById("match-banner-sub");
const uploadButton = document.getElementById("upload-button");
const uploadFileInput = document.getElementById("upload-file-input");
const linkPasteInput = document.getElementById("link-paste-input");
const linkPasteButton = document.getElementById("link-paste-button");
const matchClearButton = document.getElementById("match-clear");

function clearMatchState() {
  matchBanner.hidden = true;
  matchPreview.removeAttribute("src");
  linkPasteInput.value = "";
  uploadFileInput.value = "";
}

uploadButton.addEventListener("click", () => uploadFileInput.click());

uploadFileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  searchInput.value = "";
  sidebarActiveCategory = null;
  sidebarActiveBrand = null;
  renderSidebar();

  matchBanner.hidden = false;
  matchPreview.src = URL.createObjectURL(file);

  const result = await findExactMatchByFilename(file.name);
  showMatchResult(result);
});

linkPasteButton.addEventListener("click", async () => {
  const link = linkPasteInput.value.trim();
  if (!link) return;

  searchInput.value = "";
  sidebarActiveCategory = null;
  sidebarActiveBrand = null;
  renderSidebar();

  matchBanner.hidden = false;
  matchPreview.src = link;
  matchPreview.onerror = () => matchPreview.removeAttribute("src");

  const result = await findExactMatchByLink(link);
  showMatchResult(result);
});

linkPasteInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") linkPasteButton.click();
});

function showMatchResult(result) {
  showOnly("match");
  const matchResults = document.getElementById("match-results");

  if (result.matched) {
    matchBannerSub.textContent = "Found an exact match in the database.";
    renderGrid(matchResults, result.products, { matchBadge: true });
    return;
  }

  let message;
  if (result.reason === "no-awb-in-filename") {
    message = "This file's name doesn't contain a tracking number this database recognizes, so an exact match can't be found. If you know the AWB or product name, try the search bar instead.";
  } else if (result.reason === "awb-not-found") {
    message = `Found a tracking number in the filename (${escapeHtml(result.attemptedAwb)}), but it's not in the database yet.`;
  } else if (result.reason === "not-a-drive-link") {
    message = "That doesn't look like a Google Drive link this database can check. Paste a link to a specific file (not a folder), or try the search bar instead.";
  } else if (result.reason === "folder-link-not-file") {
    message = "That's a link to a whole Drive folder, not one specific file — paste a link to the individual image instead, or try searching by AWB in the search bar.";
  } else if (result.reason === "link-not-found") {
    message = "That Drive file isn't in the database yet.";
  } else {
    message = "No exact match was found.";
  }

  matchBannerSub.textContent = "No exact match found.";
  matchResults.innerHTML = `
    <div class="empty-state">
      <div class="empty-title">No exact match</div>
      <div class="empty-body">${message}<br><br>This database only confirms exact matches — it can't visually compare images without AI, so it won't guess at "close enough" results. Use the sidebar to browse by category if you want to look through reference images by eye.</div>
    </div>
  `;
}

matchClearButton.addEventListener("click", () => {
  clearMatchState();
  showOnly("browse");
});

// ===================================================================
// Settings modal: PIN gate + admin settings form
// ===================================================================

const settingsModal = document.getElementById("settings-modal");
const pinGate = document.getElementById("pin-gate");
const pinForm = document.getElementById("pin-form");
const pinInput = document.getElementById("pin-input");
const pinError = document.getElementById("pin-error");
const settingsPanel = document.getElementById("settings-panel");

document.getElementById("settings-tab-button").addEventListener("click", () => {
  settingsModal.hidden = false;
});

document.getElementById("settings-close").addEventListener("click", closeSettingsModal);
settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) closeSettingsModal();
});

function closeSettingsModal() {
  settingsModal.hidden = true;
  pinGate.hidden = false;
  settingsPanel.hidden = true;
  pinInput.value = "";
  pinError.hidden = true;
  pinInput.classList.remove("input-error");
}

pinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (pinInput.value === ADMIN_PIN) {
    pinError.hidden = true;
    pinGate.hidden = true;
    settingsPanel.hidden = false;
    loadSettingsForm();
  } else {
    pinError.hidden = false;
    pinInput.value = "";
    pinInput.classList.add("input-error");
  }
});

pinInput.addEventListener("input", () => {
  pinError.hidden = true;
  pinInput.classList.remove("input-error");
});

let categoryRowsState = [];

function loadSettingsForm() {
  const config = getConfig();
  document.getElementById("setting-sheet-id").value = config.sheetId;
  document.getElementById("setting-brands").value = config.knownBrands.join(", ");
  categoryRowsState = Object.entries(config.categoryLabels).map(([key, label]) => ({ key, label }));
  renderCategoryRows();
}

function renderCategoryRows() {
  const container = document.getElementById("category-rows");
  container.innerHTML = "";
  categoryRowsState.forEach((row, i) => {
    const div = document.createElement("div");
    div.className = "category-row";

    const keyInput = document.createElement("input");
    keyInput.type = "text";
    keyInput.className = "input";
    keyInput.placeholder = "e.g. mobile";
    keyInput.value = row.key;
    keyInput.addEventListener("input", (e) => { categoryRowsState[i].key = e.target.value; });

    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.className = "input";
    labelInput.placeholder = "e.g. Mobiles";
    labelInput.value = row.label;
    labelInput.addEventListener("input", (e) => { categoryRowsState[i].label = e.target.value; });

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-button";
    removeBtn.textContent = "×";
    removeBtn.setAttribute("aria-label", "Remove category");
    removeBtn.addEventListener("click", () => {
      categoryRowsState = categoryRowsState.filter((_, idx) => idx !== i);
      renderCategoryRows();
    });

    div.appendChild(keyInput);
    div.appendChild(labelInput);
    div.appendChild(removeBtn);
    container.appendChild(div);
  });
}

document.getElementById("add-category-row").addEventListener("click", () => {
  categoryRowsState.push({ key: "", label: "" });
  renderCategoryRows();
});

function showSavedMessage(text) {
  const el = document.getElementById("settings-saved-message");
  el.textContent = text;
  setTimeout(() => { el.textContent = ""; }, 2500);
}

async function refreshAfterConfigChange() {
  productCache = null;
  await loadSidebar();
  if (!browseSection.hidden) await loadBrowseDefault();
}

document.getElementById("save-settings").addEventListener("click", async () => {
  const sheetId = document.getElementById("setting-sheet-id").value.trim();
  const knownBrands = document.getElementById("setting-brands").value
    .split(",").map((b) => b.trim()).filter(Boolean);

  const categoryLabels = {};
  categoryRowsState.forEach((row) => {
    if (row.key.trim()) categoryLabels[row.key.trim()] = row.label.trim() || row.key.trim();
  });

  saveConfig({ sheetId, knownBrands, categoryLabels });
  showSavedMessage("Settings saved.");
  await refreshAfterConfigChange();
});

document.getElementById("reset-settings").addEventListener("click", async () => {
  resetConfig();
  loadSettingsForm();
  showSavedMessage("Reset to defaults.");
  await refreshAfterConfigChange();
});

document.getElementById("export-settings").addEventListener("click", () => {
  const text = JSON.stringify(getConfig(), null, 2);
  navigator.clipboard?.writeText(text);
  showSavedMessage("Settings copied to clipboard.");
});

const importTextEl = document.getElementById("import-text");
const importButton = document.getElementById("import-settings");
const importError = document.getElementById("import-error");

importTextEl.addEventListener("input", () => {
  importButton.disabled = !importTextEl.value.trim();
});

importButton.addEventListener("click", async () => {
  try {
    const parsed = JSON.parse(importTextEl.value);
    saveConfig(parsed);
    importError.hidden = true;
    importTextEl.value = "";
    importButton.disabled = true;
    loadSettingsForm();
    showSavedMessage("Settings imported.");
    await refreshAfterConfigChange();
  } catch {
    importError.hidden = false;
    importError.textContent = "That doesn't look like valid settings JSON.";
  }
});

// ===================================================================
// Init
// ===================================================================

(async function init() {
  await loadSidebar();
  await loadBrowseDefault();
})();
