/**
 * StudentVUE Proxy — Cloudflare Worker
 * ---------------------------------------------------------------
 * Deploy this for free at https://dash.cloudflare.com (Workers & Pages
 * → Create → paste this in the online editor → Deploy). No credit card
 * needed on the free plan.
 *
 * Two ways this can talk to StudentVUE, depending on what your district
 * supports:
 *
 * 1) SOAP web service (methods: grades / classes / studentinfo /
 *    schoolinfo) — the same unofficial, reverse-engineered endpoint the
 *    official StudentVUE mobile app uses. Fast (one request), but some
 *    districts running only the newer PXP2 web portal don't expose it.
 *
 * 2) PXP2 web login (methods: webLogin / webAll / webClasses /
 *    webGradebook / webProfile / webSchedule / webCourseHistory /
 *    webCalendar / webReport / webRaw) — drives the actual PXP2_Login_Student.aspx
 *    form the way a browser would: load the login page, read the
 *    hidden __VIEWSTATE/__EVENTVALIDATION fields, POST your
 *    credentials, follow the redirect, and pull studentGU off the
 *    landing page. The resulting session cookie is used server-side
 *    only and never sent back to the client.
 *
 *    IMPORTANT: use "webAll" from the app, not the five individual
 *    web* methods in parallel. Each web* call logs in from scratch —
 *    firing several at once races multiple logins for the same
 *    account against each other, and some districts invalidate an
 *    older session the moment a newer one for the same user starts.
 *    "webAll" logs in exactly once and reuses that session for every
 *    piece of data, which is both faster and far more reliable. The
 *    individual web* methods are kept around for debugging one piece
 *    at a time (e.g. from the browser console).
 *
 * Neither of these is published or supported by Edupoint (StudentVUE's
 * maker), so either could change or break without notice. If a school
 * changes its login page markup, the "web*" flow may need re-tuning —
 * use webRaw to inspect what's actually coming back.
 */

const ALLOWED_METHODS = {
  grades: "Gradebook",
  classes: "StudentClassList",
  studentinfo: "StudentInfo",
  schoolinfo: "StudentSchoolInfo",
};

const WEB_METHODS = new Set([
  "webLogin",
  "webAll",
  "webClasses",
  "webRaw",
  "webGradebook",
  "webProfile",
  "webStudentInfo",
  "webSchedule",
  "webCourseHistory",
  "webCalendar",
  "webReport",
  "webAssignments",
]);

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*", // tighten to your site's origin once it's live, e.g. "https://yoursite.com"
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeEntities(str) {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeBase(rawUrl) {
  // Accepts anything from "https://synergyweb.pusd11.net" to a full
  // login page URL, and reduces it to just the protocol + host.
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    u = new URL(`https://${rawUrl}`);
  }
  return `${u.protocol}//${u.host}`;
}

function extractSoapResult(xmlEnvelope) {
  const match = xmlEnvelope.match(
    /<ProcessWebServiceRequestResult>([\s\S]*?)<\/ProcessWebServiceRequestResult>/
  );
  if (!match) return null;
  return decodeEntities(match[1]);
}

/* ============================================================
 * PXP2 web-login helpers
 * ============================================================ */

// Cloudflare Workers' Headers object supports a non-standard getAll()
// specifically so you can read multiple Set-Cookie headers off one
// response (the standard Fetch API collapses them, which loses data).
// IMPORTANT: resp.headers.getAll(...) is NOT a real method in the Fetch
// spec or in Cloudflare Workers' Headers implementation — it's always
// undefined here, so the old "if (typeof getAll === 'function')" check
// silently fell through to .get("Set-Cookie"), which only returns ONE
// cookie whenever a response sets more than one. That's exactly what
// happens on this portal: login (and other responses) set BOTH
// ASP.NET_SessionId AND an F5 load-balancer session-affinity cookie
// (f5synergy1) in two separate Set-Cookie headers. Losing the F5 cookie
// meant later requests could land on a different backend server than
// the one LoadControl set in-memory "focus" state on — which is exactly
// the kind of inconsistent-session 500 seen from the Transfer endpoint.
// getSetCookie() is the actual Workers/modern-fetch API for this.
function collectSetCookies(resp) {
  if (typeof resp.headers.getSetCookie === "function") {
    return resp.headers.getSetCookie();
  }
  if (typeof resp.headers.getAll === "function") {
    return resp.headers.getAll("Set-Cookie");
  }
  const single = resp.headers.get("Set-Cookie");
  return single ? [single] : [];
}

function mergeCookieJar(jar, setCookieHeaders) {
  for (const sc of setCookieHeaders) {
    const nameValue = sc.split(";")[0];
    const eq = nameValue.indexOf("=");
    if (eq === -1) continue;
    jar.set(nameValue.slice(0, eq).trim(), nameValue.slice(eq + 1).trim());
  }
}

function cookieHeaderFromJar(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function fetchWithCookies(url, options, jar) {
  const headers = new Headers(options.headers || {});
  const existing = cookieHeaderFromJar(jar);
  if (existing) headers.set("Cookie", existing);
  const resp = await fetch(url, { ...options, headers, redirect: "manual" });
  mergeCookieJar(jar, collectSetCookies(resp));
  return resp;
}

// Follows redirects by hand (rather than trusting automatic redirect
// following) so the cookie jar stays in sync at every hop.
async function followRedirects(url, options, jar, maxHops = 5) {
  let currentUrl = url;
  let resp = await fetchWithCookies(currentUrl, options, jar);
  let hops = 0;
  while ([301, 302, 303, 307, 308].includes(resp.status) && hops < maxHops) {
    const loc = resp.headers.get("Location");
    if (!loc) break;
    currentUrl = new URL(loc, currentUrl).toString();
    resp = await fetchWithCookies(currentUrl, { method: "GET", headers: BROWSER_HEADERS }, jar);
    hops++;
  }
  return resp;
}

function extractHidden(html, name) {
  let re = new RegExp(`id=["']${name}["'][^>]*value=["']([^"']*)["']`, "i");
  let m = html.match(re);
  if (m) return decodeEntities(m[1]);
  // Some pages emit the value attribute before the id attribute.
  re = new RegExp(`value=["']([^"']*)["'][^>]*id=["']${name}["']`, "i");
  m = html.match(re);
  return m ? decodeEntities(m[1]) : "";
}

function extractStudentGU(html) {
  const m = html.match(
    /studentGU=([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})/i
  );
  return m ? m[1] : null;
}

function extractLoginError(html) {
  const patterns = [
    /class=["'][^"']*validation-summary-errors[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /id=["'][^"']*lbl[Ee]rror[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|div)>/i,
    /class=["'][^"']*(?:alert-danger|error-message)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const text = (m[1] || "").replace(/<[^>]+>/g, "").trim();
      if (text) return text;
    }
  }
  return null;
}

// Logs into the PXP2 web portal the way a browser would and returns
// the cookie jar (kept server-side only) plus whatever we could pull
// off the landing page.
async function pxp2Login(base, username, password) {
  const jar = new Map();
  const loginUrl = `${base}/PXP2_Login_Student.aspx?regenerateSessionId=true`;

  // Step 1: load the login page for a session + fresh VIEWSTATE/EVENTVALIDATION.
  const getResp = await fetchWithCookies(loginUrl, { method: "GET", headers: BROWSER_HEADERS }, jar);
  if (!getResp.ok) {
    throw new Error(`Couldn't load the login page (HTTP ${getResp.status}). Check the portal URL.`);
  }
  const loginHtml = await getResp.text();

  const viewstate = extractHidden(loginHtml, "__VIEWSTATE");
  const viewstateGenerator = extractHidden(loginHtml, "__VIEWSTATEGENERATOR");
  const eventValidation = extractHidden(loginHtml, "__EVENTVALIDATION");
  if (!viewstate || !eventValidation) {
    throw new Error(
      "Couldn't find the login form fields on that page — this district's login flow may not match PXP2_Login_Student.aspx. Try webRaw against the login path to inspect it."
    );
  }

  // Step 2: submit the login form, same fields a browser would post.
  const form = new URLSearchParams();
  form.set("__VIEWSTATE", viewstate);
  form.set("__VIEWSTATEGENERATOR", viewstateGenerator);
  form.set("__EVENTVALIDATION", eventValidation);
  form.set("ctl00$MainContent$username", username);
  form.set("ctl00$MainContent$password", password);
  form.set("ctl00$MainContent$Submit1", "Login");

  const postResp = await fetchWithCookies(
    loginUrl,
    {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: loginUrl,
      },
      body: form.toString(),
    },
    jar
  );

  if (postResp.status !== 302) {
    // A successful login redirects (302). Anything else means the
    // login page re-rendered — almost always bad credentials.
    const html = await postResp.text();
    const errMsg = extractLoginError(html);
    throw new Error(errMsg || "Login failed — check the username and password.");
  }

  const location = postResp.headers.get("Location") || "/Home_PXP2.aspx";
  const homeUrl = new URL(location, base).toString();
  const homeResp = await followRedirects(homeUrl, { method: "GET", headers: BROWSER_HEADERS }, jar);
  const homeHtml = await homeResp.text();

  const studentGU = extractStudentGU(homeHtml);

  return { jar, studentGU, homeHtml };
}

// Wraps pxp2Login with a couple of retries + a short backoff, since an
// occasional failed studentGU lookup tends to be a one-off hiccup on
// the district's end (not something that repeats on a fresh attempt).
// Bad credentials are NOT retried — that won't change no matter how
// many times we ask.
async function pxp2LoginWithRetry(base, username, password, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const session = await pxp2Login(base, username, password);
      if (session.studentGU) return session;
      lastErr = new Error("Logged in, but couldn't find your student ID on the landing page.");
    } catch (err) {
      lastErr = err;
      if (/check the username and password/i.test(err.message)) throw err;
    }
    if (i < attempts - 1) await sleep(500 * (i + 1)); // 500ms, then 1000ms
  }
  throw lastErr;
}

// The Gradebook page coming back empty is a different failure mode from a
// login problem — it happens on a session that DID log in successfully, so
// retrying the same session's request again is unlikely to help (it's the
// same session state that produced the empty page in the first place). What
// actually seems to help is a completely fresh login for each attempt: this
// account has enrollments at two different schools, and which one a session
// defaults to "focusing" appears to vary from login to login, occasionally
// landing somewhere that renders an empty Gradebook page. A brand new login
// gets a fresh chance at a working focus. Returns both the session (for the
// other webAll fetches to reuse) and the classes already parsed, so nothing
// has to be fetched twice.
async function establishGradebookSession(base, username, password, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    let session;
    try {
      session = await pxp2Login(base, username, password);
    } catch (err) {
      lastErr = err;
      if (/check the username and password/i.test(err.message)) throw err;
      if (i < attempts - 1) await sleep(500 * (i + 1));
      continue;
    }
    if (!session.studentGU) {
      lastErr = new Error("Logged in, but couldn't find your student ID on the landing page.");
      if (i < attempts - 1) await sleep(500 * (i + 1));
      continue;
    }
    try {
      const classes = await fetchGradebook(base, session);
      return { session, classes };
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

// Same "fresh login gets a fresh focus" idea as establishGradebookSession,
// but built for webAll instead of webGradebook: it's handed a session that
// ALREADY exists (from the one login webAll does up front) and tries that
// first — free, no extra login round trip. Only if that comes back empty
// does it fall back to a couple of brand-new logins. Callers wrap this in
// safeFetch, so however it ends, it never blocks or fails the rest of
// webAll's sections — those don't depend on the gradebook at all.
async function fetchGradebookResilient(base, username, password, initialSession, extraAttempts = 2) {
  try {
    return await fetchGradebook(base, initialSession);
  } catch (err) {
    let lastErr = err;
    for (let i = 0; i < extraAttempts; i++) {
      try {
        const session = await pxp2Login(base, username, password);
        if (!session.studentGU) {
          lastErr = new Error("Logged in, but couldn't find your student ID on the landing page.");
        } else {
          return await fetchGradebook(base, session);
        }
      } catch (err2) {
        lastErr = err2;
        if (/check the username and password/i.test(err2.message)) throw err2;
      }
      if (i < extraAttempts - 1) await sleep(400 * (i + 1));
    }
    throw lastErr;
  }
}

// Runs a data-fetching step and turns a thrown error into a labeled
// result instead of rejecting, so one failing piece (e.g. Calendar)
// doesn't take down the whole webAll response.
async function safeFetch(label, fn) {
  try {
    return { label, ok: true, data: await fn() };
  } catch (err) {
    return { label, ok: false, error: err.message || String(err) };
  }
}

/* ============================================================
 * Gradebook HTML parsing
 * ============================================================
 * PXP2_Gradebook.aspx server-renders one "gb-class-header" block per
 * class (name/teacher/room/IDs), followed by one or more
 * "gb-class-row" blocks — one per grading period shown (e.g. each
 * progress report / quarter) — each with a letter mark, a percent
 * score, missing-assignment count, and a score-history list.
 */

function extractGradingPeriods(chunk) {
  const periods = [];
  const periodRe =
    /<div class="row gb-class-row"[^>]*>([\s\S]*?)(?=<div class="row gb-class-row"|<div class="row gb-class-header|$)/g;
  let pm;
  while ((pm = periodRe.exec(chunk))) {
    const block = pm[1];
    const nameMatch = block.match(/class="btn btn-link course-markperiod"[^>]*>([^<]*)<\/button>/);
    const markMatch = block.match(/<span class="mark">([^<]*)<\/span>/);
    const scoreMatch = block.match(/<span class="score">([^<]*)<\/span>/);
    const missingMatch = block.match(/<div>(\d+) Missing Assignments<\/div>/);
    const lastUpdateMatch = block.match(/class="last-update">Last Update:\s*([^<]*)<\/span>/);

    if (!nameMatch && !markMatch && !scoreMatch) continue; // empty/irrelevant chunk

    const history = [];
    const historyRe = /<li><span class="date">([^<]*)<\/span>\s*<span class="score">([^<]*)<\/span><\/li>/g;
    let hm;
    while ((hm = historyRe.exec(block))) {
      history.push({ date: hm[1].trim(), score: hm[2].trim() });
    }

    periods.push({
      period: nameMatch ? decodeEntities(nameMatch[1]).trim() : null,
      mark: markMatch ? markMatch[1].trim() : null,
      score: scoreMatch ? scoreMatch[1].trim() : null,
      missingAssignments: missingMatch ? parseInt(missingMatch[1], 10) : null,
      lastUpdate: lastUpdateMatch ? lastUpdateMatch[1].trim() : null,
      scoreHistory: history,
    });
  }
  return periods;
}

function parseGradebookHtml(html) {
  const chunks = html.split(
    '<div class="row gb-class-header gb-class-row flexbox horizontal" data-guid="'
  );
  const classes = [];
  for (const chunk of chunks.slice(1)) {
    const idMatch = chunk.match(/^(\d+)"/);
    const classID = idMatch ? idMatch[1] : null;

    const nameMatch = chunk.match(/class="btn btn-link course-title"[^>]*>([^<]*)<\/button>/);
    const rawName = nameMatch ? decodeEntities(nameMatch[1]).trim() : null;
    // Course titles come through as "1: Environmental Science" — the leading
    // number is the class period, which the page doesn't expose as its own
    // field anywhere else. Split it off so period-matching against the
    // schedule (which does have a real period field) actually has something
    // to compare against.
    let period = null;
    let name = rawName;
    if (rawName) {
      const periodSplit = rawName.match(/^(\d+):\s*(.+)$/);
      if (periodSplit) {
        period = periodSplit[1];
        name = periodSplit[2].trim();
      }
    }

    const teacherMatch = chunk.match(/class="teacher hide-for-screen">([^<]*)<\/div>/);
    const teacher = teacherMatch ? decodeEntities(teacherMatch[1]).trim() : null;

    const roomMatch = chunk.match(/class="teacher-room hide-for-print">Room:\s*([^<]*)<\/div>/);
    const room = roomMatch ? roomMatch[1].trim() : null;

    const focusMatch = chunk.match(/class="btn btn-link course-title"[^>]*data-focus='([^']*)'/);
    let focusArgs = null;
    if (focusMatch) {
      try {
        focusArgs = JSON.parse(focusMatch[1]).FocusArgs;
      } catch {
        /* leave null if the embedded JSON doesn't parse */
      }
    }

    classes.push({
      classID,
      name,
      period,
      teacher,
      room,
      schoolID: focusArgs?.schoolID ?? null,
      teacherID: focusArgs?.teacherID ?? null,
      markPeriodGU: focusArgs?.markPeriodGU ?? null,
      gradePeriodGU: focusArgs?.gradePeriodGU ?? null,
      // Full FocusArgs object, needed verbatim to fetch this class's
      // assignments later (see fetchClassAssignments / webAssignments).
      focusArgs: focusArgs || null,
      gradingPeriods: extractGradingPeriods(chunk),
    });
  }
  return classes;
}

/* ============================================================
 * Generic inline-JSON extraction
 * ============================================================
 * PXP2 pages embed a lot of their data as server-rendered JSON
 * assigned to JS globals inside <script> tags (PXP.TodayContent,
 * PXP.CourseHistory, etc.) rather than as page-rendered HTML tables.
 * That's much easier and more reliable to parse than markup — but the
 * exact variable name a given field lives under isn't documented and
 * can vary. So instead of hardcoding names, we pull out every
 * `name = {...}` / `name = [...]` assignment on the page, then find
 * the one we want by the *shape* of its data (which keys it has),
 * which is far more stable than a variable name.
 */

// Finds the index of the bracket that closes the one opened at
// startIdx, respecting (possibly escaped) string literals so commas/
// braces inside strings don't confuse the count.
function findMatchingBracket(str, startIdx, openChar, closeChar) {
  let depth = 0;
  let inString = false;
  let stringChar = null;
  for (let i = startIdx; i < str.length; i++) {
    const c = str[i];
    if (inString) {
      if (c === "\\") {
        i++; // skip the escaped character
        continue;
      }
      if (c === stringChar) inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringChar = c;
      continue;
    }
    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractAllJsAssignments(html) {
  const results = {};
  const re = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*=\s*([{[])/g;
  let m;
  while ((m = re.exec(html))) {
    const openChar = m[2];
    const closeChar = openChar === "{" ? "}" : "]";
    const start = m.index + m[0].length - 1;
    const end = findMatchingBracket(html, start, openChar, closeChar);
    if (end === -1) continue;
    try {
      results[m[1]] = JSON.parse(html.slice(start, end + 1));
    } catch {
      /* not valid JSON (e.g. a JS expression, not a literal) — skip it */
    }
    re.lastIndex = end + 1;
  }
  return results;
}

function findByKeys(assignments, keys) {
  for (const val of Object.values(assignments)) {
    if (val && typeof val === "object" && !Array.isArray(val) && keys.every((k) => k in val)) {
      return val;
    }
  }
  return null;
}

function findArrayByElementKeys(assignments, keys) {
  for (const val of Object.values(assignments)) {
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object" && keys.every((k) => k in val[0])) {
      return val;
    }
  }
  return null;
}

function extractProfile(html) {
  const data = findByKeys(extractAllJsAssignments(html), ["students"]);
  if (!data) return null;
  const student = data.students.find((s) => s.current) || data.students[0];
  if (!student) return null;
  return {
    name: student.name ?? null,
    sisNumber: student.sisNumber ?? null,
    school: student.school ?? null,
    phone: student.phone ?? null,
    photoPath: student.photo ?? null,
  };
}

// PXP2_Student.aspx and PXP2_MyAccount.aspx both render plain
// server-side HTML tables (no embedded JSON) as
// <span class="tbl_label">Label</span><br>value pairs. Student.aspx's
// values are always single-line; MyAccount.aspx's aren't (Home
// Address and Phone Numbers span multiple lines via embedded <br>
// tags, and Mail Address/Phone Numbers can contain <i> notes) — so we
// need a version that keeps everything up to the closing </td> and
// cleans it up, not just the text before the next tag.
function extractLabeledValue(html, label) {
  const re = new RegExp(`<span class="tbl_label">${label}</span><br\\s*/?>([^<]*)`, "i");
  const m = html.match(re);
  return m ? decodeEntities(m[1]).trim() : null;
}

function extractLabeledBlock(html, label) {
  const re = new RegExp(`<span class="tbl_label">${label}</span><br\\s*/?>([\\s\\S]*?)</td>`, "i");
  const m = html.match(re);
  if (!m) return null;
  return decodeEntities(m[1])
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
}

// We split the student's full name into first/middle/last on
// whitespace — good enough for the common "First [Middle] Last"
// pattern, though a name with a multi-word last name (e.g.
// "Van Buren") will get folded into "last name" by this same
// heuristic rather than detected specially.
function extractStudentInfo(html) {
  const fullName = extractLabeledValue(html, "Student Name");
  if (!fullName) return null;
  const parts = fullName.split(/\s+/).filter(Boolean);
  let firstName = null;
  let middleName = null;
  let lastName = null;
  if (parts.length === 1) {
    firstName = parts[0];
  } else if (parts.length >= 2) {
    firstName = parts[0];
    lastName = parts[parts.length - 1];
    if (parts.length > 2) middleName = parts.slice(1, -1).join(" ");
  }
  return {
    fullName,
    firstName,
    middleName,
    lastName,
    permID: extractLabeledValue(html, "Perm ID"),
    gender: extractLabeledValue(html, "Gender"),
    grade: extractLabeledValue(html, "Grade"),
  };
}

// Parses lines like "* C: 623-270-9787" out of the Phone Numbers
// block. The page marks the primary contact number with a leading
// "*" and explains that convention in its own trailing note line —
// that note line won't match this pattern (no "Label: value" shape),
// so it's naturally excluded rather than needing to be filtered out.
function extractPhoneNumbers(block) {
  if (!block) return [];
  return block
    .split("\n")
    .map((line) => {
      const m = line.match(/^\*?\s*([A-Za-z]+):\s*(.+)$/);
      if (!m) return null;
      return { type: m[1].trim(), number: m[2].trim(), primary: line.trim().startsWith("*") };
    })
    .filter(Boolean);
}

function extractAccountInfo(html) {
  const name = extractLabeledBlock(html, "Name");
  if (!name) return null;
  return {
    name,
    userID: extractLabeledBlock(html, "User ID"),
    homeAddress: extractLabeledBlock(html, "Home Address"),
    mailAddress: extractLabeledBlock(html, "Mail Address"),
    phoneNumbers: extractPhoneNumbers(extractLabeledBlock(html, "Phone Numbers")),
  };
}

function extractSchedule(html) {
  const data = findByKeys(extractAllJsAssignments(html), ["schools"]);
  if (!data) return null;
  return (data.schools || []).map((s) => ({
    schoolName: s.schoolName ?? null,
    classes: (s.classes || []).map((c) => ({
      period: c.period ?? null,
      className: c.className ?? null,
      teacherName: c.teacherNameFNLN || c.teacherName || null,
      teacherEmail: c.teacherEmail ?? null,
      room: c.roomName ?? null,
      startTime: c.startTime ?? null,
      endTime: c.endTime ?? null,
      sectionGU: c.sectionGU ?? null,
    })),
  }));
}

function extractCourseHistory(html) {
  const data = findArrayByElementKeys(extractAllJsAssignments(html), ["Grade", "Terms"]);
  if (!data) return null;
  return data.map((g) => ({
    grade: g.Grade ?? null,
    terms: (g.Terms || []).map((t) => ({
      schoolName: t.SchoolName ?? null,
      year: t.Year ?? null,
      termName: t.TermName ?? null,
      courses: (t.Courses || []).map((c) => ({
        courseID: c.CourseID ?? null,
        title: (c.CourseTitle ?? "").trim(),
        creditsAttempted: c.CreditsAttempted ?? null,
        creditsCompleted: c.CreditsCompleted ?? null,
        mark: c.Mark ?? null,
      })),
    })),
  }));
}

// GPA/class-rank isn't in the embedded JSON — it's server-rendered
// directly as HTML on the Course History page, as one or more
// repeating blocks (e.g. "Class Rank GPA", "HS Cumulative GPA").
function extractGpaSummaries(html) {
  const results = [];
  const re =
    /<h2>([^<]*)<\/h2>\s*<span class="gpa-score">([^<]*)<\/span>\s*<span class="gpa-rank[^"]*">([^<]*)<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    const scoreText = m[2].trim();
    const rankRaw = m[3].replace(/\s+/g, " ").trim();
    const rankMatch = rankRaw.match(/Rank:\s*(\d+)\s*out of\s*(\d+)/i);
    results.push({
      label: m[1].trim(),
      gpa: scoreText ? parseFloat(scoreText) : null,
      classRank: rankMatch ? parseInt(rankMatch[1], 10) : null,
      classSize: rankMatch ? parseInt(rankMatch[2], 10) : null,
    });
  }
  return results;
}

function extractCalendar(html) {
  const data = findByKeys(extractAllJsAssignments(html), [
    "events",
    "startDate",
    "endDate",
    "showAssignments",
  ]);
  if (!data) return null;
  return {
    startDate: data.startDate ?? null,
    endDate: data.endDate ?? null,
    events: (data.events || []).map((e) => ({
      // eventType: 0 = school calendar (holiday/vacation/non-school day),
      // 1 = school-year start/end marker, 2 = a scored gradebook assignment.
      type: e.eventType ?? null,
      title: e.title ?? null,
      description: e.description ?? null,
      date: e.date ?? null,
      classGUID: e.classGUID ?? null,
      gradebookID: e.gradebookID ?? null,
    })),
  };
}

// Converts an (authenticated) image response into a data: URI so the
// front end can drop it straight into an <img src="..."> without ever
// needing the session cookie itself.
async function toDataUri(resp) {
  const buf = await resp.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const contentType = resp.headers.get("Content-Type") || "image/png";
  return `data:${contentType};base64,${btoa(binary)}`;
}

/* ============================================================
 * Individual data-fetch steps, shared by webAll and the standalone
 * web* methods so there's exactly one implementation of each.
 * ============================================================ */

async function fetchGradebook(base, session) {
  if (!session.studentGU) throw new Error("Missing studentGU — login didn't return a student ID.");
  const url = `${base}/PXP2_Gradebook.aspx?AGU=0&studentGU=${session.studentGU}`;
  const resp = await fetchWithCookies(url, { method: "GET", headers: BROWSER_HEADERS }, session.jar);
  const html = await resp.text();
  const classes = parseGradebookHtml(html);
  if (classes.length === 0) {
    // Add a bit of context to help tell apart "the page loaded but had no
    // classes on it" from "we got bounced somewhere unexpected" without
    // needing a separate webRaw round trip to find out.
    let hint = `page length ${html.length}`;
    if (/PXP2_Login/i.test(html)) hint = "landed back on a login page";
    else if (!/gb-class-header/i.test(html)) hint = "page loaded but had no recognizable class markup";
    throw new Error(`No classes found in the Gradebook page (${hint}).`);
  }
  return classes;
}

async function fetchProfile(base, session) {
  const profile = extractProfile(session.homeHtml);
  if (!profile) throw new Error("No profile data found on the landing page.");
  let photoDataUri = null;
  if (profile.photoPath) {
    try {
      const photoResp = await fetchWithCookies(
        new URL(profile.photoPath, base + "/").toString(),
        { method: "GET", headers: BROWSER_HEADERS },
        session.jar
      );
      if (photoResp.ok) photoDataUri = await toDataUri(photoResp);
    } catch {
      /* photo is optional — leave photoDataUri null if it fails */
    }
  }
  const { photoPath, ...rest } = profile;
  return { ...rest, photoDataUri };
}

// Its own Worker method (webStudentInfo) with its own place in
// webAll's error reporting, since these two pages can each succeed or
// fail independently of the landing-page profile data and of each
// other. MyAccount.aspx failing (e.g. a district that hides that page)
// still leaves the Student.aspx fields intact, and vice versa.
async function fetchStudentInfo(base, session) {
  const studentUrl = `${base}/PXP2_Student.aspx?AGU=0`;
  const studentResp = await fetchWithCookies(studentUrl, { method: "GET", headers: BROWSER_HEADERS }, session.jar);
  const studentHtml = await studentResp.text();
  const info = extractStudentInfo(studentHtml);
  if (!info) throw new Error("No student info found on that page. Use webRaw on the same path to inspect it.");

  let account = null;
  try {
    const accountUrl = `${base}/PXP2_MyAccount.aspx?AGU=0`;
    const accountResp = await fetchWithCookies(accountUrl, { method: "GET", headers: BROWSER_HEADERS }, session.jar);
    const accountHtml = await accountResp.text();
    account = extractAccountInfo(accountHtml);
  } catch {
    /* userID/address/phone are a bonus — student info still returns without them */
  }

  return {
    name: info.fullName,
    firstName: info.firstName,
    middleName: info.middleName,
    lastName: info.lastName,
    permID: info.permID,
    gender: info.gender,
    grade: info.grade,
    userID: account?.userID ?? null,
    homeAddress: account?.homeAddress ?? null,
    mailAddress: account?.mailAddress ?? null,
    phoneNumbers: account?.phoneNumbers ?? [],
  };
}

async function fetchSchedule(base, session) {
  const url = `${base}/PXP2_ClassSchedule.aspx?AGU=0`;
  const resp = await fetchWithCookies(url, { method: "GET", headers: BROWSER_HEADERS }, session.jar);
  const html = await resp.text();
  const schedule = extractSchedule(html);
  if (!schedule) throw new Error("No schedule data found on that page. Use webRaw on the same path to inspect it.");
  return { schools: schedule };
}

async function fetchCourseHistory(base, session) {
  const url = `${base}/PXP2_CourseHistory.aspx?AGU=0`;
  const resp = await fetchWithCookies(url, { method: "GET", headers: BROWSER_HEADERS }, session.jar);
  const html = await resp.text();
  const history = extractCourseHistory(html);
  const gpa = extractGpaSummaries(html);
  if (!history) throw new Error("No course history data found on that page. Use webRaw on the same path to inspect it.");
  return { history, gpa };
}

async function fetchCalendar(base, session) {
  const url = `${base}/PXP2_Calendar.aspx?AGU=0`;
  const resp = await fetchWithCookies(url, { method: "GET", headers: BROWSER_HEADERS }, session.jar);
  const html = await resp.text();
  const calendar = extractCalendar(html);
  if (!calendar) throw new Error("No calendar data found on that page. Use webRaw on the same path to inspect it.");
  return calendar;
}

// PXP2's "Documents" page lets a student download things like report
// cards and transcripts. Each report type has its own fixed GUID
// (ReportGU) that's the same for every student in the district — only
// the session/AGU changes per person. Add more entries here as you
// find their GUIDs the same way (DevTools → Network → GetReportURL).
const REPORT_GUIDS = {
  transcriptLegacy: "9F035E67-8C9D-4A79-8CB4-FCB5C9C28753", // "Unofficial Transcript (legacy)"
};

function filenameFromContentDisposition(header) {
  if (!header) return null;
  const starMatch = header.match(/filename\*=(?:UTF-8'')?["']?([^"';]+)["']?/i);
  if (starMatch) {
    try { return decodeURIComponent(starMatch[1]); } catch { /* fall through */ }
  }
  const plainMatch = header.match(/filename=["']?([^"';]+)["']?/i);
  return plainMatch ? plainMatch[1] : null;
}

async function fetchReport(base, session, reportKey) {
  const reportGU = REPORT_GUIDS[reportKey];
  if (!reportGU) {
    throw new Error(`Unknown reportKey "${reportKey}". Known reports: ${Object.keys(REPORT_GUIDS).join(", ")}`);
  }

  const urlResp = await fetchWithCookies(
    `${base}/service/PXP2Communication.asmx/GetReportURL`,
    {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${base}/Home_PXP2.aspx`,
      },
      body: JSON.stringify({ reportArgs: { AGU: 0, ReportGU: reportGU } }),
    },
    session.jar
  );
  const urlText = await urlResp.text();
  let urlParsed;
  try {
    urlParsed = JSON.parse(urlText);
  } catch {
    throw new Error("Unexpected response requesting the report — the endpoint may have changed.");
  }
  if (urlParsed?.d?.Error) throw new Error(errToString(urlParsed.d.Error) || "Couldn't get a download link for that report.");
  const downloadPath = urlParsed?.d?.Data?.DownloadURL;
  if (!downloadPath) throw new Error("No download link came back for that report.");

  const fileUrl = new URL(downloadPath, base + "/").toString();
  const fileResp = await fetchWithCookies(fileUrl, { method: "GET", headers: BROWSER_HEADERS }, session.jar);
  if (!fileResp.ok) throw new Error(`Couldn't download the report (HTTP ${fileResp.status}).`);

  const contentType = fileResp.headers.get("Content-Type") || "application/pdf";
  const filename =
    filenameFromContentDisposition(fileResp.headers.get("Content-Disposition")) ||
    `${reportKey}.${contentType.includes("pdf") ? "pdf" : "bin"}`;
  const dataUri = await toDataUri(fileResp);

  return { dataUri, filename, contentType };
}

// Fetching a single class's assignments is a two-step dance:
//
// 1. LoadControl tells the server "this session is now focused on this
//    class" (school/class/mark-period/grade-period GUIDs, straight from
//    the FocusArgs object the Gradebook page embedded for that class).
//    Its response is scaffolding HTML we don't need — the side effect
//    on the session is what matters.
// 2. ClientSideData/Transfer then asks for the assignment list, but
//    takes NO class identifiers of its own — it reads whichever class
//    step 1 just focused, out of session state. So these two calls
//    have to run in order, on the same session, back to back.
// Some of PXP2's JSON endpoints put a structured object in their Error
// field instead of a plain string (e.g. {Message: "...", ...}) — coerce
// whatever comes back into readable text instead of letting it become
// the literal string "[object Object]" once it hits `new Error(...)`.
function errToString(val) {
  if (val == null) return null;
  if (typeof val === "string") return val;
  if (typeof val === "object") {
    if (val.Message) return String(val.Message);
    try {
      return JSON.stringify(val);
    } catch {
      return String(val);
    }
  }
  return String(val);
}

async function fetchClassAssignments(base, session, focusArgs) {
  const studentGU = focusArgs.studentGU ?? session.studentGU;
  const agu = focusArgs.AGU ?? "0";
  const gradebookUrl = `${base}/PXP2_Gradebook.aspx?AGU=${agu}&studentGU=${studentGU}`;

  // A real browser is always already sitting on Gradebook.aspx (a full
  // page load) before it fires any of the AJAX calls below — and that
  // page load appears to set server-side session state (student/school/
  // focus context) later calls depend on. Calling them "cold" in a
  // session that never visited this page throws server-side, so we
  // always visit it first — harmless if the caller (e.g. webAll) already
  // did, since it's idempotent.
  await fetchWithCookies(gradebookUrl, { method: "GET", headers: BROWSER_HEADERS }, session.jar);

  const referer = gradebookUrl;

  // Confirmed against a full HAR capture of a real session: EVERY call
  // on the page — both LoadControl calls and all four ClientSideData/
  // Transfer calls — sends the exact same FOCUS_KEY, and it's not the
  // one LoadControl's own response contains. It's whatever
  // GradebookFocusClassInfo (a page-level, grading-period-scoped call)
  // returned. LoadControl's own FOCUS_KEY field is essentially a red
  // herring for this flow — the real browser never sends it back
  // anywhere. Establish the real one here first.
  const focusInfoResp = await fetchWithCookies(
    `${base}/service/PXP2Communication.asmx/GradebookFocusClassInfo`,
    {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Referer: referer,
        AGU: String(agu),
      },
      body: JSON.stringify({
        request: {
          gradingPeriodGU: focusArgs.gradePeriodGU ?? null,
          AGU: agu,
          orgYearGU: focusArgs.OrgYearGU ?? null,
          schoolID: focusArgs.schoolID ?? null,
          markPeriodGU: focusArgs.markPeriodGU ?? null,
        },
      }),
    },
    session.jar
  );
  if (!focusInfoResp.ok) {
    const bodyText = await focusInfoResp.text().catch(() => "");
    throw new Error(`Couldn't establish the gradebook focus key (HTTP ${focusInfoResp.status}). ${bodyText.slice(0, 300)}`);
  }
  const focusInfoText = await focusInfoResp.text();
  let focusKey = null;
  let debugFocusInfoClasses = null;
  try {
    const focusInfoParsed = JSON.parse(focusInfoText);
    const errText = errToString(focusInfoParsed?.d?.Error);
    if (errText) throw new Error(errText);
    focusKey = focusInfoParsed?.d?.FOCUS_KEY ?? null;
    debugFocusInfoClasses = (focusInfoParsed?.d?.Data?.Classes || []).map((c) => ({ name: c.Name, id: c.ID }));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error("GradebookFocusClassInfo returned non-JSON — can't get a FOCUS_KEY to proceed.");
    }
    throw err;
  }
  if (!focusKey) {
    throw new Error("GradebookFocusClassInfo didn't return a FOCUS_KEY.");
  }

  // LoadControl's job here is just its side effect: pointing this
  // FOCUS_KEY's server-side session state at this specific class/view
  // (viewName: "courseContent" is what the real browser sends right
  // before loading the assignment list — confirmed by HAR). We deliberately
  // ignore whatever FOCUS_KEY comes back from it (see above).
  const controlParams = {
    schoolID: focusArgs.schoolID ?? null,
    classID: focusArgs.classID ?? null,
    gradePeriodGU: focusArgs.gradePeriodGU ?? null,
    subjectID: focusArgs.subjectID ?? -1,
    teacherID: focusArgs.teacherID ?? -1,
    markPeriodGU: focusArgs.markPeriodGU ?? null,
    assignmentID: focusArgs.assignmentID ?? -1,
    standardIdentifier: focusArgs.standardIdentifier ?? null,
    viewName: "courseContent",
    studentGU,
    AGU: agu,
    OrgYearGU: focusArgs.OrgYearGU ?? null,
  };

  const loadControlResp = await fetchWithCookies(
    `${base}/service/PXP2Communication.asmx/LoadControl`,
    {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Referer: referer,
        AGU: String(agu),
      },
      body: JSON.stringify({
        request: {
          control: "Gradebook_RichContentClassDetails",
          parameters: controlParams,
        },
      }),
    },
    session.jar
  );
  if (!loadControlResp.ok) {
    const bodyText = await loadControlResp.text().catch(() => "");
    throw new Error(
      `Couldn't open that class's detail view (HTTP ${loadControlResp.status}). ${bodyText.slice(0, 300)}`
    );
  }
  const loadControlText = await loadControlResp.text();
  let debugLoadControlFocusKey = null;
  let debugLoadControlSnippet = null;
  try {
    const loadControlParsed = JSON.parse(loadControlText);
    const errText = errToString(loadControlParsed?.d?.Error);
    if (errText) throw new Error(errText);
    debugLoadControlFocusKey = loadControlParsed?.d?.FOCUS_KEY ?? null;
    debugLoadControlSnippet = (loadControlParsed?.d?.Data?.html || "").slice(0, 600);
  } catch (err) {
    if (err instanceof SyntaxError) {
      /* not JSON — some districts return plain HTML here on success too, so don't treat this alone as fatal */
      debugLoadControlSnippet = loadControlText.slice(0, 600);
    } else {
      throw err;
    }
  }

  // Every call below goes through the same generic Transfer endpoint,
  // identified only by FriendlyName/Method — confirmed against a real
  // browser capture that its own Parameters really are sent as "{}"
  // (or close to it); the class context comes entirely from the
  // server-side session state LoadControl just set (keyed by focusKey,
  // established above via GradebookFocusClassInfo), not from anything
  // in these payloads.
  async function transferCall(friendlyName, methodName, parametersObj = {}) {
    const resp = await fetchWithCookies(
      `${base}/api/GB/ClientSideData/Transfer?action=${friendlyName}-${methodName}`,
      {
        method: "POST",
        headers: {
          ...BROWSER_HEADERS,
          "Accept": "application/json, text/javascript, */*; q=0.01",
          "Content-Type": "application/json; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          "CURRENT_WEB_PORTAL": "StudentVUE",
          "Origin": base,
          "Referer": referer,
          "FOCUS_KEY": focusKey,
        },
        body: JSON.stringify({
          FriendlyName: friendlyName,
          Method: methodName,
          Parameters: JSON.stringify(parametersObj),
        }),
      },
      session.jar
    );

    const text = await resp.text();

    if (!resp.ok) {
      throw new Error(
        `${friendlyName}/${methodName} failed (HTTP ${resp.status}). ${text.slice(0, 1200)}`
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `${friendlyName}/${methodName} returned non-JSON: ${text.slice(0, 400)}`
      );
    }

    const errText =
      errToString(parsed?.metaData?.errorMessage) ||
      errToString(parsed?.Error);

    if (errText) throw new Error(errText);

    return parsed;
  }

  // genericdata.classdata/GetClassData and pxp.course.cards/get are
  // confirmed working against a real browser capture, and — as of a
  // second capture — so is this content.items/LoadWithOptions call now
  // that viewName is null and the group selector is capitalized to
  // match exactly what the browser sends (see controlParams above).
  let classDataResult;
  let cardsResult;
  let contentResult;

  try {
    classDataResult = {
      status: "fulfilled",
      value: await transferCall("genericdata.classdata", "GetClassData")
    };
  } catch (err) {
    classDataResult = {
      status: "rejected",
      reason: err
    };
  }

  try {
    cardsResult = {
      status: "fulfilled",
      value: await transferCall("pxp.course.grade.card", "get")
    };
  } catch (err) {
    cardsResult = {
      status: "rejected",
      reason: err
    };
  }

  let courseContentResult;

  try {
    courseContentResult = {
      status: "fulfilled",
      value: await transferCall("pxp.course.content", "get")
    };
  } catch (err) {
    courseContentResult = {
      status: "rejected",
      reason: err
    };
  }

  try {
    contentResult = {
      status: "fulfilled",
      value: await transferCall("pxp.course.content.items", "LoadWithOptions", {
        loadOptions: {
          sort: [{ selector: "due_date", desc: false }],
          filter: [["isDone", "=", false]],
          group: [{ Selector: "Week", desc: false }],
          requireTotalCount: true,
          userData: {},
        },
        clientState: {},
      })
    };
  } catch (err) {
    contentResult = {
      status: "rejected",
      reason: err
    };
  }

  const classData = classDataResult.status === "fulfilled" ? classDataResult.value : null;
  const student = classData?.students?.[0] ?? null;
  const classGradeRow = Array.isArray(classData?.classGrades) ? classData.classGrades[0] : null;

  // Category weights (e.g. "Aligned Checks" 20%, "Major Projects and
  // Assessments" 60%) — the client matches each assignment to one of
  // these by name (assignmentType) or id. Previously this was never
  // sent at all, so the client's weighted-category math silently had
  // nothing to work with and always fell back to the flat percentage.
  const measureTypes = Array.isArray(classData?.measureTypes)
    ? classData.measureTypes.map((m) => ({ id: m.id, name: m.name, weight: m.weight }))
    : [];

  // The letter-grade cutoffs actually used for THIS class specifically —
  // reportCardScoreTypes has several unrelated scales (percentage bands,
  // rubric scores, standards scales, etc.); classGrades tells us which
  // one this class's grade is actually reported against.
  let scoreScales = [];
  if (classGradeRow?.reportCardScoreTypeId != null && Array.isArray(classData?.reportCardScoreTypes)) {
    const matchingScale = classData.reportCardScoreTypes.find(
      (t) => t.id === classGradeRow.reportCardScoreTypeId
    );
    if (matchingScale && Array.isArray(matchingScale.details)) {
      scoreScales = matchingScale.details
        .filter((d) => d.lowScore != null && d.highScore != null && d.lowScore >= 0)
        .map((d) => ({ score: d.score, lowScore: d.lowScore, highScore: d.highScore }));
    }
  }

  const cards =
    cardsResult.status === "fulfilled"
      ? (cardsResult.value?.cards || []).map((c) => ({
        type: c.type ?? null,
        text: c.text ?? null,
        count: c.count ?? null,
        detail: c.mutedText ?? null,
      }))
      : [];

  function formatAssignmentWeekLabel(value) {
    const raw = String(value ?? "").trim();

    const match = raw.match(
      /^Week\s*(\d+)\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+through\s+(\d{1,2})\/(\d{1,2})\/(\d{4})$/i
    );

    if (!match) return raw;

    const weekNumber = parseInt(match[1], 10);

    const start = new Date(
      Number(match[4]),
      Number(match[2]) - 1,
      Number(match[3]),
      12
    );

    const end = new Date(
      Number(match[7]),
      Number(match[5]) - 1,
      Number(match[6]),
      12
    );

    const startMonth = start.toLocaleDateString("en-US", {
      month: "long"
    });

    const endMonth = end.toLocaleDateString("en-US", {
      month: "long"
    });

    const startDay = start.getDate();
    const endDay = end.getDate();

    const range =
      start.getFullYear() === end.getFullYear() &&
        start.getMonth() === end.getMonth()
        ? `${startMonth} ${startDay}-${endDay}`
        : `${startMonth} ${startDay} - ${endMonth} ${endDay}`;

    return `Week ${weekNumber} • ${range}`;
  }

  let weeks = [];
  if (contentResult.status === "fulfilled") {
    const rawWeeks = contentResult.value?.responseData?.data || [];
    weeks = rawWeeks.map((w) => ({
      week: formatAssignmentWeekLabel(w.key),
      items: (w.items || []).map((i) => ({
        title: i.title ?? null,
        unit: i.unit ?? null,
        assignmentType: i.assignmentType ?? null,
        dueDate: i.due_date ?? null,
        pointsPossible: i.pointsPossible ?? null,
        gradeMark: i.gradeMark ?? null,
        percent: i.calcValue ?? null,
        isMissing: !!i.isMissing,
        comment: i.commentText ?? null,
        itemType: i.itemType ?? null, // "GradeBookItem" (graded) or "Content" (a resource/link, ungraded)
        hasGrade: !!i.showAssignmentGrade,
      })),
    }));
  }

  return {
    className: classData?.className ?? null,
    gradingPeriodName: classData?.GradingPeriodName ?? null,
    markType: classData?.markType ?? null,
    mark: student?.calculatedMark ?? student?.manualMark ?? null,
    percentage: classGradeRow?.totalWeightedPercentage ?? student?.percentage ?? null,
    posted: student?.postedGrade ?? null,
    measureTypes,
    scoreScales,
    cards,
    weeks,
    classDataAvailable: classDataResult.status === "fulfilled",
    classDataError: classDataResult.status === "rejected" ? errToString(classDataResult.reason?.message) : null,
    cardsAvailable: cardsResult.status === "fulfilled",
    cardsError: cardsResult.status === "rejected" ? errToString(cardsResult.reason?.message) : null,
    assignmentListAvailable: contentResult.status === "fulfilled",
    assignmentListError: contentResult.status === "rejected" ? errToString(contentResult.reason?.message) : null,
    // Temporary diagnostics — remove once this is confirmed working.
    debugFocusKeyUsed: focusKey,
    debugFocusInfoClasses,
    debugLoadControlFocusKey,
    debugLoadControlSnippet,
  };
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Use POST." }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body." }, 400);
    }

    const { username, password, portalUrl, method, reportPeriod, path, webMethod, webBody, reportKey, focusArgs } = body;

    if (!method) {
      return jsonResponse({ error: "Missing \"method\"." }, 400);
    }

    /* -------- PXP2 web-login flow -------- */
    if (WEB_METHODS.has(method)) {
      if (!username || !password || !portalUrl) {
        return jsonResponse({ error: "Missing one of: username, password, portalUrl." }, 400);
      }

      let base;
      try {
        base = normalizeBase(portalUrl);
      } catch {
        return jsonResponse({ error: "Couldn't understand that portal URL." }, 400);
      }

      let session;
      let preloadedClasses = null;
      try {
        if (method === "webGradebook") {
          // This one specifically needs a *working* gradebook, not just a
          // successful login — see establishGradebookSession's comment for
          // why a fresh login-per-attempt matters here.
          const established = await establishGradebookSession(base, username, password);
          session = established.session;
          preloadedClasses = established.classes;
        } else {
          // webAll (and everything else) only needs ONE successful login.
          // Classes/Gradebook is handled separately below, in parallel with
          // the rest of webAll's sections — a flaky Gradebook page used to
          // gate the entire response behind up to 3 fresh logins before any
          // other section even started fetching. Now a bad Gradebook only
          // costs that one section, and the rest starts immediately.
          session = await pxp2LoginWithRetry(base, username, password);
        }
      } catch (err) {
        return jsonResponse({ error: err.message || "Login failed." }, 401);
      }

      if (method === "webLogin") {
        // Just proves the credentials work and shows what we could find.
        return jsonResponse({ success: true, studentGU: session.studentGU });
      }

      // The one method the app should actually use day-to-day: logs in
      // ONCE, then fetches every piece of data using that same session.
      // The individual fetches below are all plain GETs against an
      // already-established session, so running them in parallel is
      // safe — the risk was only ever multiple concurrent *logins*.
      if (method === "webAll") {
        // All six sections fire together off the one login above. Classes/
        // Gradebook gets its own resilient path (fetchGradebookResilient
        // falls back to a couple of fresh logins if the shared session's
        // Gradebook page comes back empty) — but it's wrapped in safeFetch
        // just like the rest, so it failing never blocks or delays anything
        // else in this response.
        const [gradebookResult, profileResult, studentInfoResult, scheduleResult, historyResult, calendarResult] = await Promise.all([
          safeFetch("webGradebook", () => fetchGradebookResilient(base, username, password, session)),
          safeFetch("webProfile", () => fetchProfile(base, session)),
          safeFetch("webStudentInfo", () => fetchStudentInfo(base, session)),
          safeFetch("webSchedule", () => fetchSchedule(base, session)),
          safeFetch("webCourseHistory", () => fetchCourseHistory(base, session)),
          safeFetch("webCalendar", () => fetchCalendar(base, session)),
        ]);

        const results = {};
        const errors = [];
        for (const r of [gradebookResult, profileResult, studentInfoResult, scheduleResult, historyResult, calendarResult]) {
          if (!r.ok) {
            errors.push(`${r.label}: ${r.error}`);
            continue;
          }
          if (r.label === "webGradebook") results.classes = r.data;
          else if (r.label === "webProfile") results.profile = r.data;
          else if (r.label === "webStudentInfo") results.studentInfo = r.data;
          else if (r.label === "webSchedule") results.schedule = r.data;
          else if (r.label === "webCourseHistory") results.courseHistory = r.data;
          else if (r.label === "webCalendar") results.calendar = r.data;
        }

        return jsonResponse({ ...results, studentGU: session.studentGU, errors });
      }

      if (method === "webGradebook") {
        return jsonResponse({ classes: preloadedClasses, studentGU: session.studentGU });
      }

      if (method === "webClasses") {
        const url = `${base}/service/PXP2Communication.asmx/GradebookFocusClassInfo`;
        const resp = await fetchWithCookies(
          url,
          {
            method: "POST",
            headers: {
              ...BROWSER_HEADERS,
              "Content-Type": "application/json; charset=UTF-8",
              "X-Requested-With": "XMLHttpRequest",
              Referer: `${base}/Home_PXP2.aspx`,
            },
            body: JSON.stringify({}),
          },
          session.jar
        );
        const text = await resp.text();
        try {
          const parsed = JSON.parse(text);
          if (parsed?.d?.Error) {
            return jsonResponse({ error: errToString(parsed.d.Error) || "Unknown error from the classes endpoint." }, 502);
          }
          return jsonResponse({ data: parsed?.d?.Data ?? parsed, studentGU: session.studentGU });
        } catch {
          return jsonResponse(
            { error: "Unexpected response from the classes endpoint.", raw: text.slice(0, 500) },
            502
          );
        }
      }

      if (method === "webProfile") {
        try {
          const profile = await fetchProfile(base, session);
          return jsonResponse({ ...profile, studentGU: session.studentGU });
        } catch (err) {
          return jsonResponse({ error: err.message }, 502);
        }
      }

      if (method === "webStudentInfo") {
        try {
          const info = await fetchStudentInfo(base, session);
          return jsonResponse({ ...info, studentGU: session.studentGU });
        } catch (err) {
          return jsonResponse({ error: err.message }, 502);
        }
      }

      if (method === "webSchedule") {
        try {
          const schedule = await fetchSchedule(base, session);
          return jsonResponse({ ...schedule, studentGU: session.studentGU });
        } catch (err) {
          return jsonResponse({ error: err.message }, 502);
        }
      }

      if (method === "webCourseHistory") {
        try {
          const courseHistory = await fetchCourseHistory(base, session);
          return jsonResponse({ ...courseHistory, studentGU: session.studentGU });
        } catch (err) {
          return jsonResponse({ error: err.message }, 502);
        }
      }

      if (method === "webCalendar") {
        try {
          const calendar = await fetchCalendar(base, session);
          return jsonResponse({ ...calendar, studentGU: session.studentGU });
        } catch (err) {
          return jsonResponse({ error: err.message }, 502);
        }
      }

      if (method === "webReport") {
        if (!reportKey) {
          return jsonResponse({ error: "Missing \"reportKey\"." }, 400);
        }
        try {
          const report = await fetchReport(base, session, reportKey);
          return jsonResponse({ ...report, studentGU: session.studentGU });
        } catch (err) {
          return jsonResponse({ error: err.message }, 502);
        }
      }

      if (method === "webAssignments") {
        if (!focusArgs || typeof focusArgs !== "object") {
          return jsonResponse({ error: "Missing \"focusArgs\" (pass the class's own focusArgs object from webGradebook/webAll)." }, 400);
        }
        try {
          const detail = await fetchClassAssignments(base, session, focusArgs);
          return jsonResponse({ ...detail, studentGU: session.studentGU });
        } catch (err) {
          return jsonResponse({ error: err.message }, 502);
        }
      }

      if (method === "webRaw") {
        // Generic authenticated fetch of any path on the portal, for
        // reverse-engineering endpoints (e.g. whatever actually returns
        // grade values) or fetching Gradebook.aspx itself. GET by
        // default; pass webMethod: "POST" + webBody: {...} for AJAX
        // PageMethods-style endpoints.
        if (!path || typeof path !== "string" || !path.startsWith("/")) {
          return jsonResponse({ error: "Missing or invalid \"path\" (must start with \"/\")." }, 400);
        }
        let target;
        try {
          target = new URL(path, base);
          if (target.host !== new URL(base).host) throw new Error("host mismatch");
        } catch {
          return jsonResponse({ error: "That path doesn't resolve to the portal's own site." }, 400);
        }

        const init = {
          method: webMethod === "POST" ? "POST" : "GET",
          headers: { ...BROWSER_HEADERS, Referer: `${base}/Home_PXP2.aspx` },
        };
        if (init.method === "POST") {
          init.headers["Content-Type"] = "application/json; charset=UTF-8";
          init.headers["X-Requested-With"] = "XMLHttpRequest";
          init.body = JSON.stringify(webBody || {});
        }

        const resp = await fetchWithCookies(target.toString(), init, session.jar);
        const text = await resp.text();
        const contentType = resp.headers.get("Content-Type") || "";
        if (contentType.includes("json")) {
          try {
            return jsonResponse({ data: JSON.parse(text), studentGU: session.studentGU });
          } catch {
            /* fall through to returning raw text below */
          }
        }
        return jsonResponse({ html: text, studentGU: session.studentGU, status: resp.status });
      }
    }

    /* -------- Original SOAP web-service flow -------- */
    if (!username || !password || !portalUrl) {
      return jsonResponse(
        { error: "Missing one of: username, password, portalUrl, method." },
        400
      );
    }

    const methodName = ALLOWED_METHODS[method];
    if (!methodName) {
      return jsonResponse(
        {
          error: `Unknown method "${method}". Use one of: ${Object.keys(ALLOWED_METHODS).join(
            ", "
          )}, ${[...WEB_METHODS].join(", ")}`,
        },
        400
      );
    }

    let paramStr;
    if (method === "classes") {
      paramStr = "<Parms><childIntID>0</childIntID></Parms>";
    } else if (method === "grades" && reportPeriod !== undefined && reportPeriod !== null && reportPeriod !== "") {
      paramStr = `<Parms><ChildIntID>0</ChildIntID><ReportPeriod>${escapeXml(reportPeriod)}</ReportPeriod></Parms>`;
    } else {
      paramStr = "<Parms><ChildIntID>0</ChildIntID></Parms>";
    }

    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ProcessWebServiceRequest xmlns="http://edupoint.com/webservices/"><userID>${escapeXml(
      username
    )}</userID><password>${escapeXml(
      password
    )}</password><skipLoginLog>1</skipLoginLog><parent>0</parent><webServiceHandleName>PXPWebServices</webServiceHandleName><methodName>${methodName}</methodName><paramStr>${escapeXml(
      paramStr
    )}</paramStr></ProcessWebServiceRequest></soap:Body></soap:Envelope>`;

    let base;
    try {
      base = normalizeBase(portalUrl);
    } catch {
      return jsonResponse({ error: "Couldn't understand that portal URL." }, 400);
    }

    let upstreamResp;
    try {
      upstreamResp = await fetch(`${base}/Service/PXPCommunication.asmx`, {
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: "http://edupoint.com/webservices/ProcessWebServiceRequest",
          "User-Agent": "StudentVUE/24.0.0 CFNetwork/1568.100.1 Darwin/24.0.0",
          Accept: "*/*",
          "Accept-Language": "en-us",
        },
        body: soapBody,
      });
    } catch (err) {
      return jsonResponse(
        { error: "Couldn't reach the StudentVUE server. Check the portal URL." },
        502
      );
    }

    const rawXml = await upstreamResp.text();
    const resultXml = extractSoapResult(rawXml);

    if (!resultXml) {
      return jsonResponse(
        { error: "Unexpected response from StudentVUE. The login or portal URL may be wrong." },
        502
      );
    }

    // A failed login/request can come back a couple of different ways
    // depending on the district's StudentVUE version — check both.
    const rtErrorMatch = resultXml.match(/<RT_ERROR[^>]*>([\s\S]*?)<\/RT_ERROR>/i) ||
      resultXml.match(/ERROR_MESSAGE="([^"]*)"/i);
    if (rtErrorMatch && rtErrorMatch[1] && rtErrorMatch[1].trim()) {
      return jsonResponse({ error: rtErrorMatch[1].trim() }, 401);
    }

    const errorMatch = resultXml.match(/ErrorMessage="([^"]*)"/);
    if (errorMatch && errorMatch[1]) {
      return jsonResponse({ error: errorMatch[1] }, 401);
    }

    return jsonResponse({ xml: resultXml });
  },
};