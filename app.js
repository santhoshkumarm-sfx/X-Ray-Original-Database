// ===================================================================
// Scanline — plain HTML/JS build, no server, no build step.
// Open index.html directly in a browser, or host these 3 files as
// static files anywhere (Vercel/Netlify/GitHub Pages all work with
// zero config since there's no build command).
// ===================================================================

const ADMIN_PIN = "403403";
const STORAGE_KEY = "scanline_admin_config";

const DEFAULT_CONFIG = {
  sheetId: "1DhPGeiQZh-P7tln3MiBZfrvb35B-_12mf-DCBZl194I",
  knownBrands: [
    "Apple", "Samsung", "OnePlus", "Xiaomi", "Redmi", "Realme", "Vivo",
    "Oppo", "Sony", "boAt", "Noise", "JBL", "Bose", "Garmin", "Fitbit",
    "Google", "Nothing", "Motorola", "Asus", "Lenovo", "Dell", "HP"
  ],
  categoryLabels: {
    mobile: "Mobiles",
    headphone: "Headphones",
    smartwatch: "Smartwatch"
  }
};

// ===================================================================
// Admin config: read/write to localStorage
// ===================================================================

function getConfig() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return structuredClone(DEFAULT_CONFIG);
    const parsed = JSON.parse(stored);
    return {
      sheetId: parsed.sheetId || DEFAULT_CONFIG.sheetId,
      knownBrands: Array.isArray(parsed.knownBrands) && parsed.knownBrands.length > 0
        ? parsed.knownBrands : DEFAULT_CONFIG.knownBrands,
      categoryLabels: parsed.categoryLabels && Object.keys(parsed.categoryLabels).length > 0
        ? parsed.categoryLabels : DEFAULT_CONFIG.categoryLabels
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

function saveConfig(config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

function resetConfig() {
  localStorage.removeItem(STORAGE_KEY);
}

// ===================================================================
// Data pipeline: fetch the Google Sheet, parse CSV, clean names
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

function driveLinkToImageUrl(driveLink) {
  if (!driveLink) return null;
  const match = driveLink.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) return null;
  return `https://drive.google.com/thumbnail?id=${match[1]}&sz=w1000`;
}

// Minimal CSV parser handling quoted fields with embedded commas/quotes —
// needed because product_name cells contain JSON-like text.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') { field += '"'; i++; }
      else if (char === '"') { inQuotes = false; }
      else { field += char; }
    } else {
      if (char === '"') { inQuotes = true; }
      else if (char === ",") { row.push(field); field = ""; }
      else if (char === "\n" || char === "\r") {
        if (char === "\r" && next === "\n") i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else { field += char; }
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function rowsToProducts(rows, config) {
  const dataRows = rows.slice(1).filter((r) => r[0] && r[0].trim());

  return dataRows.map((r) => {
    const awb = (r[0] || "").trim();
    const rawName = (r[1] || "").trim();
    const rawCategory = (r[2] || "").trim().toLowerCase();
    const xrayLink = (r[3] || "").trim();

    const brand = detectBrand(rawName, config.knownBrands);
    const category = config.categoryLabels[rawCategory] || rawCategory || "Uncategorized";
    const cleanedName = cleanProductName(rawName, category);
    const details = extractStorageOrColor(rawName);

    return {
      awb,
      productName: cleanedName,
      fullDetails: details.join(", "),
      category,
      categoryKey: rawCategory,
      brand,
      image: driveLinkToImageUrl(xrayLink),
      sourceLink: xrayLink
    };
  });
}

// Bundled fallback data (mirrors the real sheet's structure) used only if
// the live fetch fails — e.g. offline, or Google briefly unreachable.
const FALLBACK_ROWS = [
  ["awb_number", "product_name", "product_category", "X-ray link"],
  ["SF3201408623F", `Apple MWTY3ZM/A White 195949506123 {"For Serial Number":"Scan S/N Bar-code"} {"Comment":"Check the Silver Seal Tape on product & reject if found VOID on it."} {"ean":"195949506123"} 2000`, "headphone", "https://drive.google.com/file/d/1-_3xE_oQJ6Shom7Xxw7djxkBuuiBLX2T/view?usp=sharing"],
  ["SF2016986091F", `Apple iPhone 16 MYEA3HN/A Pink 195949822193 128 GB {"":""} {"Comment_1":"In case the Silver/Yellow seals are not present on the mobile or the seals are damaged, hand over the mobile to SBS+pack IRT"} {"ram":"0 GB"} 69900`, "mobile", "https://drive.google.com/file/d/12ro1hlY7_kZh7poEb9dWNagCwCKyuZrc/view?usp=sharing"],
  ["SF2948568422F", `Apple Watch SE 2 GPS 40mm (2nd Gen) Midnight Aluminium with Ink Sport Loop 195949641961 Black Ink MXEA3HN/A {"Comment_1":"Check the Silver Seal Tape on product reject if found VOID on it."} Ink 20900`, "smartwatch", "https://drive.google.com/file/d/15ViF3myDUu3SelfGGwRWl60ccBGRgY0T/view?usp=sharing"],
  ["SF2613662733F", `Apple iPhone 17 MG6K4HN/A White 195950643640 256 GB {"":""} {"Comment_1":"In case the Silver/Yellow seals are not present"} {"ram":"0 GB"} 82900`, "mobile", "https://drive.google.com/file/d/16XV2EZqhNFlx3b1E6YlWPu1b-3k7FYXF/view?usp=sharing"],
  ["SF2437847300F", `Apple iPhone 16 MYEA3HN/A Pink 195949822193 128 GB {"":""} {"ram":"0 GB"} 69900`, "mobile", "https://drive.google.com/file/d/1AYhbPiXQI91Io8r3szIds7fuztJldKN_/view?usp=sharing"],
  ["SF2616351472F", `Apple iPhone 17 MG6M4HN/A Lavender 195950644043 256 GB {"":""} {"ram":"0 GB"} 82900`, "mobile", "https://drive.google.com/file/d/1c7b8rTChvkQGa6_my8QZEXAJETjDyb4g/view?usp=sharing"],
  ["SF2616692840F", `Apple Watch SE 2 GPS 44mm (2nd Gen) Starlight Aluminium with Starlight Sport Band 195949645747 Silver Starlight MXEV3HN/A {"Comment_1":"Check the Silver Seal Tape"} Starlight 27900`, "smartwatch", "https://drive.google.com/file/d/1gA_K1dCDq2eIvCFs_SiIR9yBxG1XyjLQ/view?usp=sharing"],
  ["SF2017644657F", `Apple MWTY3ZM/A White 195949506123 {"For Serial Number":"Scan S/N Bar-code"} 2000`, "headphone", "https://drive.google.com/file/d/1itGcZITpF8KnPKIcuxFuw0XFVmmdaox3/view?usp=sharing"],
  ["SF2615266638F", `Apple MWTY3ZM/A White 195949506123 {"For Serial Number":"Scan S/N Bar-code"} 2000`, "headphone", "https://drive.google.com/file/d/1IX-2AJay0DLx5qcw0gT7TDLDotKRLdKw/view?usp=sharing"],
  ["SF2018250692F", `Apple Watch SE 2 GPS 40mm (2nd Gen) Midnight Aluminium with Ink Sport Loop 195949641961 Black Ink MXEA3HN/A Ink 20900`, "smartwatch", "https://drive.google.com/file/d/1JgQqwFOji59mb8vAE7m6fNZkrH8uAVkH/view?usp=sharing"],
  ["SF2613332374F", `Apple iPhone 17 MG6M4HN/A Lavender 195950644043 256 GB {"":""} {"ram":"0 GB"} 82900`, "mobile", "https://drive.google.com/file/d/1pNTbuSLfC_ZG1EIHffGfmTrGmeZ9Nm6U/view?usp=sharing"],
  ["SF2437689855F", `Apple iPhone 17 MG6J4HN/A Black 195950643442 256 GB {"":""} {"ram":"0 GB"} 82900`, "mobile", "https://drive.google.com/file/d/1qSVEcWZlXPYwrBIHXpRiq6vF5LH-MGek/view?usp=sharing"],
  ["SF2014864095F", `Apple iPhone 16 MYEC3HN/A Ultramarine 195949822377 128 GB {"":""} {"ram":"0 GB"} 69900`, "mobile", "https://drive.google.com/file/d/1YLaXXCkpU-NWWISy2TT95wTUm1ecjq4t/view?usp=sharing"]
];

async function getProducts() {
  const config = getConfig();
  const now = Date.now();

  if (productCache && productCacheSheetId === config.sheetId && now - productCacheTime < CACHE_MS) {
    return rowsToProducts(productCache, config);
  }

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${config.sheetId}/export?format=csv`;

  try {
    const res = await fetch(sheetUrl);
    if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
    const csvText = await res.text();
    const rows = parseCSV(csvText);
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

// ===================================================================
// Rendering helpers
// ===================================================================

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function renderResultCard(product) {
  const card = document.createElement("div");
  card.className = "card";

  const imageWrap = document.createElement("div");
  imageWrap.className = "image-wrap";

  if (product.image) {
    const img = document.createElement("img");
    img.src = product.image;
    img.alt = `X-ray reference image of ${product.productName}`;
    img.className = "card-image";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => {
      imageWrap.innerHTML = "";
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
        link.textContent = "Open in Drive";
        fallback.appendChild(link);
      }
      imageWrap.appendChild(fallback);
    };
    imageWrap.appendChild(img);

    const scanLine = document.createElement("div");
    scanLine.className = "scan-line";
    imageWrap.appendChild(scanLine);
    setTimeout(() => scanLine.remove(), 750);
  } else {
    const fallback = document.createElement("div");
    fallback.className = "image-fallback";
    fallback.innerHTML = `<span>Image unavailable</span>`;
    imageWrap.appendChild(fallback);
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

// ===================================================================
// Tab navigation
// ===================================================================

const tabs = document.querySelectorAll(".tab");
const panels = {
  search: document.getElementById("tab-search"),
  browse: document.getElementById("tab-browse"),
  upload: document.getElementById("tab-upload"),
  settings: document.getElementById("tab-settings")
};

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab;
    tabs.forEach((t) => {
      const active = t === tab;
      t.classList.toggle("tab-active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
    Object.entries(panels).forEach(([key, panel]) => {
      panel.hidden = key !== target;
    });

    if (target === "browse" && !browseLoaded) loadBrowseTab();
    if (target === "upload" && !uploadCategoriesLoaded) loadUploadCategories();
  });
});

// ===================================================================
// Search tab
// ===================================================================

const searchInput = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");
let searchDebounce = null;

searchInput.addEventListener("input", (e) => {
  const value = e.target.value;
  clearTimeout(searchDebounce);

  if (!value.trim()) {
    searchResults.innerHTML = `<div class="idle-state">Type an AWB number, product name, or brand to pull up reference x-ray images.</div>`;
    return;
  }

  searchDebounce = setTimeout(async () => {
    searchResults.innerHTML = `<div class="status-text">Scanning library…</div>`;
    const results = await searchProducts(value);

    if (results.length === 0) {
      searchResults.innerHTML = `
        <div class="empty-state">
          <div class="empty-title">No match found</div>
          <div class="empty-body">Nothing in the library matches "${escapeHtml(value)}". Check the spelling, or browse by category if you're not sure of the exact name.</div>
        </div>
      `;
      return;
    }

    searchResults.innerHTML = "";
    const grid = document.createElement("div");
    grid.className = "results-grid";
    results.forEach((p) => grid.appendChild(renderResultCard(p)));
    searchResults.appendChild(grid);
  }, 250);
});

// ===================================================================
// Browse tab
// ===================================================================

let browseLoaded = false;
let browseCategories = [];
let browseActiveCategory = null;
let browseActiveBrand = null;

async function loadBrowseTab() {
  browseLoaded = true;
  browseCategories = await getCategories();
  renderBrowseSidebar();
  if (browseCategories[0]) {
    selectBrowseCategory(browseCategories[0].category);
  }
}

function renderBrowseSidebar() {
  const sidebar = document.getElementById("browse-sidebar");
  sidebar.innerHTML = "";
  browseCategories.forEach((c) => {
    const btn = document.createElement("button");
    btn.className = c.category === browseActiveCategory ? "cat-button cat-button-active" : "cat-button";
    btn.innerHTML = `<span>${escapeHtml(c.category)}</span><span class="count">${c.count}</span>`;
    btn.addEventListener("click", () => selectBrowseCategory(c.category));
    sidebar.appendChild(btn);
  });
}

async function selectBrowseCategory(category) {
  browseActiveCategory = category;
  browseActiveBrand = null;
  renderBrowseSidebar();
  renderBrowseBrandRow();
  await loadBrowseResults();
}

function renderBrowseBrandRow() {
  const row = document.getElementById("browse-brand-row");
  const current = browseCategories.find((c) => c.category === browseActiveCategory);
  row.innerHTML = "";
  if (!current) return;

  const allBtn = document.createElement("button");
  allBtn.className = browseActiveBrand === null ? "brand-chip brand-chip-active" : "brand-chip";
  allBtn.textContent = "All brands";
  allBtn.addEventListener("click", () => selectBrowseBrand(null));
  row.appendChild(allBtn);

  current.brands.forEach((b) => {
    const btn = document.createElement("button");
    btn.className = browseActiveBrand === b ? "brand-chip brand-chip-active" : "brand-chip";
    btn.textContent = b;
    btn.addEventListener("click", () => selectBrowseBrand(b));
    row.appendChild(btn);
  });
}

async function selectBrowseBrand(brand) {
  browseActiveBrand = brand;
  renderBrowseBrandRow();
  await loadBrowseResults();
}

async function loadBrowseResults() {
  const results = document.getElementById("browse-results");
  results.innerHTML = `<div class="status-text">Loading…</div>`;
  const items = await getProductsByCategory(browseActiveCategory, browseActiveBrand);
  results.innerHTML = "";
  if (items.length === 0) {
    results.innerHTML = `<div class="placeholder">No items in this category yet.</div>`;
    return;
  }
  items.forEach((item) => results.appendChild(renderResultCard(item)));
}

// ===================================================================
// Upload & compare tab
// ===================================================================

let uploadCategoriesLoaded = false;
let uploadCategories = [];
let uploadActiveCategory = null;

const uploadButton = document.getElementById("upload-button");
const uploadFileInput = document.getElementById("upload-file-input");
const uploadCompareLayout = document.getElementById("upload-compare-layout");
const uploadPreview = document.getElementById("upload-preview");

uploadButton.addEventListener("click", () => uploadFileInput.click());

uploadFileInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  uploadPreview.src = URL.createObjectURL(file);
  uploadCompareLayout.hidden = false;
  uploadButton.textContent = "Replace image";
});

async function loadUploadCategories() {
  uploadCategoriesLoaded = true;
  uploadCategories = await getCategories();
  const chips = document.getElementById("upload-category-chips");
  chips.innerHTML = "";
  uploadCategories.forEach((c) => {
    const btn = document.createElement("button");
    btn.className = "chip";
    btn.textContent = c.category;
    btn.addEventListener("click", () => selectUploadCategory(c.category, btn));
    chips.appendChild(btn);
  });
}

async function selectUploadCategory(category, btnEl) {
  uploadActiveCategory = category;
  document.querySelectorAll("#upload-category-chips .chip").forEach((b) => {
    b.classList.toggle("chip-active", b === btnEl);
  });

  const placeholder = document.getElementById("upload-placeholder");
  const results = document.getElementById("upload-results");
  placeholder.hidden = true;
  results.innerHTML = `<div class="status-text">Loading…</div>`;

  const items = await getProductsByCategory(category, null);
  results.innerHTML = "";
  items.forEach((item) => results.appendChild(renderResultCard(item)));
}

// ===================================================================
// Settings tab: PIN gate + admin settings form
// ===================================================================

const pinGate = document.getElementById("pin-gate");
const pinForm = document.getElementById("pin-form");
const pinInput = document.getElementById("pin-input");
const pinError = document.getElementById("pin-error");
const settingsPanel = document.getElementById("settings-panel");

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

document.getElementById("save-settings").addEventListener("click", () => {
  const sheetId = document.getElementById("setting-sheet-id").value.trim();
  const knownBrands = document.getElementById("setting-brands").value
    .split(",").map((b) => b.trim()).filter(Boolean);

  const categoryLabels = {};
  categoryRowsState.forEach((row) => {
    if (row.key.trim()) categoryLabels[row.key.trim()] = row.label.trim() || row.key.trim();
  });

  saveConfig({ sheetId, knownBrands, categoryLabels });
  showSavedMessage("Settings saved.");

  // Force a re-fetch next time data is requested, and refresh any loaded tabs
  productCache = null;
  browseLoaded = false;
  uploadCategoriesLoaded = false;
});

document.getElementById("reset-settings").addEventListener("click", () => {
  resetConfig();
  loadSettingsForm();
  showSavedMessage("Reset to defaults.");
  productCache = null;
  browseLoaded = false;
  uploadCategoriesLoaded = false;
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

importButton.addEventListener("click", () => {
  try {
    const parsed = JSON.parse(importTextEl.value);
    saveConfig(parsed);
    importError.hidden = true;
    importTextEl.value = "";
    importButton.disabled = true;
    loadSettingsForm();
    showSavedMessage("Settings imported.");
    productCache = null;
    browseLoaded = false;
    uploadCategoriesLoaded = false;
  } catch {
    importError.hidden = false;
    importError.textContent = "That doesn't look like valid settings JSON.";
  }
});
