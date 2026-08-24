/* ===== SHORTCUTS ===== */
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);
const save = (key, val) => { localStorage.setItem(key, JSON.stringify(val)); queueCloudSync(key); };
const load = key => JSON.parse(localStorage.getItem(key));
const openModal = id => $(id).classList.add("show");
const closeModal = id => $(id).classList.remove("show");
const updateSelection = (containerId, itemSel, attr, value) =>
    $$(`#${containerId} ${itemSel}`).forEach(el => el.classList.toggle("selected", el.dataset[attr] === value));

/* ===== ACCOUNT & CLOUD SYNC ===== */
const SYNC_KEYS = ["Profile", "SchoolInfo", "Classes", "CalendarEvents", "DayColors", "Projects", "HomeLinks", "StudySets", "GpaCourses", "GpaSettings", "Notes", "RichNotes", "Checklists", "PasswordEntries", "StudentVueCreds"];

const firebaseConfig = {
    apiKey: "AIzaSyDpDhllQm24yZNAKn9gy3sF7zSGTKnXY0Y",
    authDomain: "my-student-hub-4c697.firebaseapp.com",
    projectId: "my-student-hub-4c697",
    storageBucket: "my-student-hub-4c697.firebasestorage.app",
    messagingSenderId: "651985103374",
    appId: "1:651985103374:web:20e38ec776e683704bea5f"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
try {
    db.enablePersistence({ synchronizeTabs: true }).catch(err => {
        console.warn("Offline cache unavailable:", err.code);
    });
} catch (e) { console.warn("Offline cache unavailable:", e); }

let cloudSyncTimer = null;
let applyingRemoteData = false;
let cloudUnsubscribe = null;
let initialSyncDone = false;

function localSnapshot() {
    const snap = {};
    SYNC_KEYS.forEach(k => { snap[k] = load(k) ?? null; });
    return snap;
}

function canonicalJSON(obj) {
    if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
    if (Array.isArray(obj)) return "[" + obj.map(canonicalJSON).join(",") + "]";
    const keys = Object.keys(obj).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJSON(obj[k])).join(",") + "}";
}

function snapshotsEqual(a, b) { return canonicalJSON(a) === canonicalJSON(b); }

function queueCloudSync(key) {
    if (!auth.currentUser || applyingRemoteData || !SYNC_KEYS.includes(key)) return;
    setSyncStatus("Syncing…");
    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(pushLocalToCloud, 800);
}

function pushLocalToCloud() {
    const user = auth.currentUser;
    if (!user) return;
    db.collection("users").doc(user.uid).set(localSnapshot(), { merge: true })
        .then(() => setSyncStatus("Synced"))
        .catch(err => { console.error("Sync failed:", err); setSyncStatus("Sync error — will retry"); });
}

function applyCloudSnapshot(data) {
    applyingRemoteData = true;
    SYNC_KEYS.forEach(k => {
        if (data[k] !== undefined && data[k] !== null) localStorage.setItem(k, JSON.stringify(data[k]));
    });
    applyingRemoteData = false;
}

function setSyncStatus(text) {
    const el = $("accountSyncStatus");
    if (el) el.textContent = text;
}

function showSyncBanner() {
    if ($("cloudSyncBanner")) return;
    const banner = document.createElement("div");
    banner.id = "cloudSyncBanner";
    banner.style.cssText = "position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:var(--blue);color:#fff;padding:10px 18px;border-radius:14px;font-size:13px;font-weight:600;box-shadow:var(--shadow);z-index:999;cursor:pointer;max-width:85vw;text-align:center;";
    banner.textContent = "Updated on another device — tap to refresh";
    banner.onclick = () => location.reload();
    document.body.appendChild(banner);
}

function renderAccountUI(user) {
    const subtitle = $("accountSettingsSubtitle");
    const outView = $("accountSignedOutView");
    const inView = $("accountSignedInView");
    if (user) {
        if (subtitle) subtitle.textContent = user.email;
        if (outView) outView.style.display = "none";
        if (inView) inView.style.display = "block";
        const emailEl = $("accountEmailDisplay");
        if (emailEl) emailEl.textContent = user.email;
        setSyncStatus(navigator.onLine ? "Syncing…" : "Offline — will sync when back online");
    } else {
        if (subtitle) subtitle.textContent = "Sign in to sync across devices";
        if (outView) outView.style.display = "block";
        if (inView) inView.style.display = "none";
    }
}

function accountShowError(msg) {
    const el = $("accountError");
    el.textContent = msg;
    el.style.display = "block";
}
function accountClearError() {
    const el = $("accountError");
    el.style.display = "none";
    el.textContent = "";
}

/* ===== REMEMBERED ACCOUNTS (device-local only, never synced) =====
   Note: to allow one-tap login, the password is stored locally on this
   device (localStorage) alongside the email. It is never synced to the
   cloud or sent anywhere except back to Firebase to sign in. */
const REMEMBERED_ACCOUNTS_KEY = "RememberedAccounts";
function getRememberedAccounts() {
    let list = JSON.parse(localStorage.getItem(REMEMBERED_ACCOUNTS_KEY)) || [];
    // migrate old format (plain email strings) to {email, password}
    return list.map(item => typeof item === "string" ? { email: item, password: null } : item);
}
function setRememberedAccounts(list) { localStorage.setItem(REMEMBERED_ACCOUNTS_KEY, JSON.stringify(list)); }

function rememberAccountEmail(email, password) {
    if (!email) return;
    let list = getRememberedAccounts();
    const existing = list.find(a => a.email.toLowerCase() === email.toLowerCase());
    const finalPassword = (password !== undefined && password !== null && password !== "")
        ? password
        : (existing ? existing.password : null);
    list = list.filter(a => a.email.toLowerCase() !== email.toLowerCase());
    list.unshift({ email, password: finalPassword });
    setRememberedAccounts(list.slice(0, 5));
    renderRecentAccounts();
}

function forgetAccountEmail(email, event) {
    if (event) event.stopPropagation();
    setRememberedAccounts(getRememberedAccounts().filter(a => a.email.toLowerCase() !== email.toLowerCase()));
    renderRecentAccounts();
}

function selectRecentAccount(email) {
    const account = getRememberedAccounts().find(a => a.email.toLowerCase() === email.toLowerCase());
    accountClearError();
    $("accountEmail").value = email;
    if (account && account.password) {
        $("accountPassword").value = account.password;
        accountLogIn();
    } else {
        $("accountPassword").value = "";
        $("accountPassword").focus();
    }
}

function renderRecentAccounts() {
    const wrap = $("recentAccountsWrap");
    const list = $("recentAccountsList");
    if (!wrap || !list) return;
    const accounts = getRememberedAccounts();
    if (!accounts.length) { wrap.style.display = "none"; list.innerHTML = ""; return; }
    wrap.style.display = "block";
    list.innerHTML = accounts.map(a => `
      <button type="button" class="recent-account-chip" onclick="selectRecentAccount('${escapeHTML(a.email)}')">
        <span>${escapeHTML(a.email)}</span>
        <span class="recent-account-remove" onclick="forgetAccountEmail('${escapeHTML(a.email)}', event)">×</span>
      </button>
    `).join("");
}

function openAccountPage() { accountClearError(); renderRecentAccounts(); openToolPage("accountPage"); }

function accountSignUp() {
    accountClearError();
    const email = $("accountEmail").value.trim();
    const password = $("accountPassword").value;
    if (!email || !password) { accountShowError("Enter an email and password."); return; }
    if (password.length < 6) { accountShowError("Password must be at least 6 characters."); return; }
    auth.createUserWithEmailAndPassword(email, password)
        .then(() => rememberAccountEmail(email, password))
        .catch(err => accountShowError(err.message));
}

function accountLogIn() {
    accountClearError();
    const email = $("accountEmail").value.trim();
    const password = $("accountPassword").value;
    if (!email || !password) { accountShowError("Enter an email and password."); return; }
    auth.signInWithEmailAndPassword(email, password)
        .then(() => rememberAccountEmail(email, password))
        .catch(err => accountShowError(err.message));
}

function accountLogOut() {
    if (!confirm("Log out? Your data stays on this device and will sync again next time you log in.")) return;
    if (cloudUnsubscribe) { cloudUnsubscribe(); cloudUnsubscribe = null; }
    auth.signOut();
}

function openDeleteAccountModal() {
    const pwd = $("deleteAccountPassword");
    const err = $("deleteAccountError");
    if (pwd) pwd.value = "";
    if (err) { err.style.display = "none"; err.textContent = ""; }
    openModal("deleteAccountModal");
}

function confirmDeleteAccount() {
    const user = auth.currentUser;
    const err = $("deleteAccountError");
    if (!user) return;
    const password = $("deleteAccountPassword").value;
    err.style.display = "none";
    if (!password) { err.textContent = "Enter your password to confirm."; err.style.display = "block"; return; }

    const email = user.email;
    const credential = firebase.auth.EmailAuthProvider.credential(email, password);

    user.reauthenticateWithCredential(credential)
        .then(() => db.collection("users").doc(user.uid).delete().catch(() => { }))
        .then(() => user.delete())
        .then(() => {
            if (cloudUnsubscribe) { cloudUnsubscribe(); cloudUnsubscribe = null; }
            forgetAccountEmail(email);
            closeModal("deleteAccountModal");
            alert("Your account has been permanently deleted.");
        })
        .catch(e => {
            err.textContent = e.code === "auth/wrong-password" ? "Incorrect password." : e.message;
            err.style.display = "block";
        });
}

auth.onAuthStateChanged(user => {
    renderAccountUI(user);
    if (cloudUnsubscribe) { cloudUnsubscribe(); cloudUnsubscribe = null; }
    if (!user) { initialSyncDone = false; return; }
    initialSyncDone = false;
    rememberAccountEmail(user.email);
    const docRef = db.collection("users").doc(user.uid);
    cloudUnsubscribe = docRef.onSnapshot(snap => {
        if (snap.metadata.hasPendingWrites) return;
        if (!snap.exists) {
            if (!initialSyncDone) { initialSyncDone = true; pushLocalToCloud(); }
            return;
        }
        const incoming = snap.data() || {};
        if (!initialSyncDone) {
            initialSyncDone = true;
            const reloadGuardKey = "SyncReloaded_" + user.uid;
            if (!snapshotsEqual(incoming, localSnapshot())) {
                applyCloudSnapshot(incoming);
                if (!sessionStorage.getItem(reloadGuardKey)) {
                    sessionStorage.setItem(reloadGuardKey, "1");
                    location.reload();
                } else {
                    setSyncStatus("Synced");
                }
            } else {
                sessionStorage.removeItem(reloadGuardKey);
                setSyncStatus("Synced");
            }
            return;
        }
        if (snapshotsEqual(incoming, localSnapshot())) { setSyncStatus("Synced"); return; }
        applyCloudSnapshot(incoming);
        showSyncBanner();
    }, err => { console.error("Sync listener error:", err); setSyncStatus("Sync error"); });
});

window.addEventListener("online", () => { if (auth.currentUser) setSyncStatus("Back online — syncing…"); });
window.addEventListener("offline", () => { if (auth.currentUser) setSyncStatus("Offline — changes will sync when back online"); });

/* ===== DATA ===== */
let profile = load("Profile") || { name: "", grade: "", birthday: "", meid: "", major: "", email: "", phone: "", currentGPA: "", avatar: "", avatarSource: "", avatarCrop: null };
(function sanitizeProfile() {
    let changed = false;
    ["name", "grade", "birthday", "meid", "major", "email", "phone"].forEach(k => {
        if (profile[k] === "undefined" || profile[k] === "null") { profile[k] = ""; changed = true; }
    });
    if (changed) save("Profile", profile);
})();
let schoolInfo = load("SchoolInfo") || { name: "", abbr: "" };
profile.currentGPA = profile.currentGPA ?? "";
let classes = load("Classes") || [];
let calendarEvents = load("CalendarEvents") || [];
let dayColors = load("DayColors") || {};

let editingClassID = null, editingEventID = null, selectedEventColor = "#1769c2", selectedDayForColor = null;
let calendarDate = new Date(), calendarView = "month";

let projects = load("Projects") || [];
let currentProjectID = null, editingProjectID = null, editingTaskID = null, pendingTaskImage = null;
let selectedProjectColor = "#1769c2", selectedTaskStatus = "todo", selectedTaskPriority = "medium";

let homeLinks = load("HomeLinks") || {
    student: [
        { id: 1, icon: "🎓", title: "Student Center", description: "Classes, grades and account", url: "https://redirect.maricopa.edu/student-center" },
        { id: 2, icon: "📚", title: "Canvas", description: "Courses and assignments", url: "https://learn.maricopa.edu/" },
        { id: 3, icon: "🏫", title: "GCC", description: "College website", url: "https://www.gccaz.edu/" },
        { id: 4, icon: "✉️", title: "Student Email", description: "School email", url: "http://google.maricopa.edu/" }
    ],
    quick: [
        { id: 5, icon: "🌐", title: "Maricopa Community Colleges", description: "Main Maricopa website", url: "https://www.maricopa.edu/" },
        { id: 6, icon: "📖", title: "GCC Student Resources", description: "Student services and resources", url: "https://www.gccaz.edu/students" },
        { id: 7, icon: "📅", title: "Academic Calendar", description: "Important dates", url: "https://www.gccaz.edu/academic-calendar" }
    ]
};
let homeEditMode = false, editingLinkType = null, editingLinkID = null;

let studySets = load("StudySets") || [];
let currentSetID = null, editingSetID = null, editingCardID = null, selectedSetColor = "#1769c2", pendingCardImage = null;
let studyModeCards = [], studyModeIndex = 0;
let quizQuestions = [], quizIndex = 0, quizScore = 0, quizAnswered = false, quizSelectedAnswers = [];

let passwordEntries = load("PasswordEntries") || [];
let editingPasswordID = null;

let gpaCourses = load("GpaCourses") || [];
let editingGpaID = null;
let gpaSettings = load("GpaSettings") || { useCurrent: false, priorCredits: "" };

let notes = load("Notes") || [];
let editingNoteID = null;
let pendingNoteImage = null;

let richNotes = load("RichNotes") || [];
let editingRichNoteID = null;

let checklists = load("Checklists") || [];
let currentChecklistID = null, editingChecklistID = null, selectedChecklistColor = "#1769c2";

let timerInterval = null, timerSeconds = 25 * 60, timerIsBreak = false, timerRunning = false, timerCycle = 1;

/* ===== NAVIGATION ===== */
function showPage(pageID, button) {
    $$(".page").forEach(p => p.classList.remove("active"));
    $(pageID).classList.add("active");
    $$(".nav-button").forEach(n => n.classList.remove("active"));
    button.classList.add("active");
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (pageID === "classes") renderClasses();
    if (pageID === "calendar") renderCalendar();
    if (pageID === "home") renderHomeLinks();
}

function openToolPage(pageID) {
    $$(".page").forEach(p => p.classList.remove("active"));
    $(pageID).classList.add("active");
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function showSettingsFromTools() {
    $$(".page").forEach(p => p.classList.remove("active"));
    $("settings").classList.add("active");
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function showProfileFromTools() { showSettingsFromTools(); }

function showToolsFromTool() {
    $$(".page").forEach(p => p.classList.remove("active"));
    $("tools").classList.add("active");
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function openPage(url) { window.open(url, '_blank'); }

/* ===== HOME LINKS ===== */
function toggleHomeEditMode() {
    homeEditMode = !homeEditMode;
    const btn = $("homeEditButton");
    btn.classList.toggle("active", homeEditMode);
    btn.textContent = homeEditMode ? "✓" : "✎";
    renderHomeLinks();
}

function renderHomeLinks() {
    const grid = $("studentLinksGrid");
    grid.innerHTML = "";
    homeLinks.student.forEach(link => {
        const btn = document.createElement("button");
        btn.className = "button";
        btn.onclick = () => homeEditMode ? openLinkModal("student", link.id) : openPage(link.url);
        btn.innerHTML = `
        ${homeEditMode ? `<div class="link-remove" onclick="event.stopPropagation();deleteLinkQuick('student', ${link.id})">✕</div>` : ""}
        <div class="icon">${link.icon}</div>
        <div class="button-title">${escapeHTML(link.title)}</div>
        <div class="button-description">${escapeHTML(link.description)}</div>
      `;
        grid.appendChild(btn);
    });
    if (homeEditMode) {
        const addBtn = document.createElement("button");
        addBtn.className = "button add-tile";
        addBtn.onclick = () => openLinkModal("student");
        addBtn.innerHTML = `<div class="icon">➕</div><div class="button-title">Add Link</div><div class="button-description">New shortcut card</div>`;
        grid.appendChild(addBtn);
    }

    const list = $("quickLinksList");
    list.innerHTML = "";
    homeLinks.quick.forEach(link => {
        const btn = document.createElement("button");
        btn.className = "list-button";
        btn.onclick = () => homeEditMode ? openLinkModal("quick", link.id) : openPage(link.url);
        btn.innerHTML = `
        <div class="list-icon">${link.icon}</div>
        <div class="list-info">
          <div class="list-title">${escapeHTML(link.title)}</div>
          <div class="list-subtitle">${escapeHTML(link.description)}</div>
        </div>
        <div class="arrow">${homeEditMode ? "✎" : "›"}</div>
      `;
        list.appendChild(btn);
    });
    if (homeEditMode) {
        const addBtn = document.createElement("button");
        addBtn.className = "list-button add-tile";
        addBtn.onclick = () => openLinkModal("quick");
        addBtn.innerHTML = `<div class="list-icon">➕</div><div class="list-info"><div class="list-title">Add Link</div><div class="list-subtitle">New quick access item</div></div>`;
        list.appendChild(addBtn);
    }
}

function deleteLinkQuick(type, id) {
    if (!confirm("Remove this link?")) return;
    homeLinks[type] = homeLinks[type].filter(l => l.id !== id);
    save("HomeLinks", homeLinks);
    renderHomeLinks();
}

function openLinkModal(type, id = null) {
    editingLinkType = type;
    editingLinkID = id;
    if (id === null) {
        $("linkModalTitle").textContent = type === "student" ? "Add Student Link" : "Add Quick Access Link";
        $("editLinkIcon").value = "🔗";
        $("editLinkTitle").value = "";
        $("editLinkDescription").value = "";
        $("editLinkURL").value = "";
        $("deleteLinkButton").style.display = "none";
    } else {
        const link = homeLinks[type].find(l => l.id === id);
        if (!link) return;
        $("linkModalTitle").textContent = "Edit Link";
        $("editLinkIcon").value = link.icon;
        $("editLinkTitle").value = link.title;
        $("editLinkDescription").value = link.description;
        $("editLinkURL").value = link.url;
        $("deleteLinkButton").style.display = "block";
    }
    openModal("linkModal");
}


function saveLink() {
    const title = $("editLinkTitle").value.trim();
    const url = $("editLinkURL").value.trim();
    if (!title) { alert("Please enter a title."); return; }
    if (!url) { alert("Please enter a URL."); return; }
    const linkData = {
        icon: $("editLinkIcon").value.trim() || "🔗",
        title,
        description: $("editLinkDescription").value.trim(),
        url
    };
    if (editingLinkID === null) {
        linkData.id = Date.now();
        homeLinks[editingLinkType].push(linkData);
    } else {
        const i = homeLinks[editingLinkType].findIndex(l => l.id === editingLinkID);
        if (i !== -1) homeLinks[editingLinkType][i] = { ...homeLinks[editingLinkType][i], ...linkData };
    }
    save("HomeLinks", homeLinks);
    closeModal('linkModal');
    renderHomeLinks();
}

function deleteCurrentLink() {
    if (editingLinkID === null) return;
    if (!confirm("Delete this link?")) return;
    homeLinks[editingLinkType] = homeLinks[editingLinkType].filter(l => l.id !== editingLinkID);
    save("HomeLinks", homeLinks);
    closeModal('linkModal');
    renderHomeLinks();
}

/* ===== PROFILE ===== */
function renderProfile() {
    const clean = v => (v && v !== "undefined" && v !== "null") ? v : "";
    const name = clean(profile.name) || "Student";
    $("homeName").textContent = name + " 👋";
    const initials = name.split(" ").map(w => w[0]).join("").substring(0, 2).toUpperCase() || "S";
    ["settingsProfileAvatar", "profileInfoAvatar"].forEach(id => {
        const el = $(id);
        if (!el) return;
        el.innerHTML = profile.avatar ? `<img src="${profile.avatar}" alt="Profile photo">` : initials;
    });
    $("removePhotoBtn").style.display = profile.avatar ? "inline-block" : "none";
    const adjustBtn = $("adjustPhotoBtn");
    if (adjustBtn) adjustBtn.style.display = profile.avatarSource ? "inline-block" : "none";
    const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };
    setText("settingsProfileName", name);
    setText("profileInfoName", name);
    setText("settingsProfileInfoName", name);
    setText("settingsProfileBirthday", clean(profile.birthday) || "—");
    setText("settingsProfileMEID", clean(profile.meid) || "—");
    setText("settingsProfileEmail", clean(profile.email) || "—");
    setText("settingsProfilePhone", formatPhone(clean(profile.phone)) || "—");
    setText("settingsCurrentGPA", profile.currentGPA !== "" && profile.currentGPA != null ? Number(profile.currentGPA).toFixed(2) : "—");
    setText("homeGradeBadge", clean(profile.grade) || "—");
}

/* Resizes an uploaded image file to a max dimension and returns a JPEG data URL */
function resizeImageFile(file, maxSize) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => {
            const img = new Image();
            img.onload = () => {
                let w = img.width, h = img.height;
                if (w > maxSize || h > maxSize) {
                    const scale = maxSize / Math.max(w, h);
                    w = Math.round(w * scale);
                    h = Math.round(h * scale);
                }
                const canvas = document.createElement("canvas");
                canvas.width = w;
                canvas.height = h;
                canvas.getContext("2d").drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL("image/jpeg", 0.85));
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function handleAvatarUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    const dataUrl = await resizeImageFile(file, 1000);
    event.target.value = "";
    openAvatarCrop(dataUrl);
}

function adjustAvatarPhoto() {
    if (!profile.avatarSource) return;
    openAvatarCrop(profile.avatarSource, profile.avatarCrop || null);
}

function removeAvatarPhoto() {
    if (!confirm("Remove your profile photo?")) return;
    profile.avatar = "";
    profile.avatarSource = "";
    profile.avatarCrop = null;
    save("Profile", profile);
    renderProfile();
}

/* ===== AVATAR CROP ===== */
let avatarCropImgEl = null;
let avatarCropNaturalW = 0, avatarCropNaturalH = 0;
let avatarCropBaseW = 0, avatarCropBaseH = 0;
let avatarCropContainerSize = 0;
let avatarCropZoom = 1;
let avatarCropDX = 0, avatarCropDY = 0;
let avatarCropSourceDataUrl = null;
let avatarCropDragging = false;
let avatarCropDragStart = { x: 0, y: 0 };
let avatarCropStartOffset = { x: 0, y: 0 };
const avatarCropActivePointers = new Map();
let avatarCropPinchStartDist = 0;
let avatarCropPinchStartZoom = 1;
const AVATAR_CROP_MIN_ZOOM = 1;
const AVATAR_CROP_MAX_ZOOM = 3;

function openAvatarCrop(sourceDataUrl, existingCropState = null) {
    avatarCropSourceDataUrl = sourceDataUrl;
    openModal("avatarCropModal");
    const img = $("avatarCropImg");
    avatarCropImgEl = img;
    img.onload = () => {
        avatarCropNaturalW = img.naturalWidth;
        avatarCropNaturalH = img.naturalHeight;
        const viewport = $("avatarCropViewport");
        avatarCropContainerSize = viewport.clientWidth;
        const baseScale = avatarCropContainerSize / Math.min(avatarCropNaturalW, avatarCropNaturalH);
        avatarCropBaseW = avatarCropNaturalW * baseScale;
        avatarCropBaseH = avatarCropNaturalH * baseScale;
        img.style.width = avatarCropBaseW + "px";
        img.style.height = avatarCropBaseH + "px";
        if (existingCropState) {
            avatarCropZoom = existingCropState.zoom || 1;
            avatarCropDX = existingCropState.dx || 0;
            avatarCropDY = existingCropState.dy || 0;
        } else {
            avatarCropZoom = 1;
            avatarCropDX = 0;
            avatarCropDY = 0;
        }
        clampAvatarCropOffset();
        applyAvatarCropTransform();
    };
    img.src = sourceDataUrl;
}

function closeAvatarCrop() {
    closeModal("avatarCropModal");
    avatarCropSourceDataUrl = null;
    avatarCropActivePointers.clear();
    avatarCropPinchStartDist = 0;
    avatarCropDragging = false;
}

function clampAvatarCropOffset() {
    const z = avatarCropZoom;
    const maxDx = Math.max(0, avatarCropBaseW / 2 - avatarCropContainerSize / (2 * z));
    const maxDy = Math.max(0, avatarCropBaseH / 2 - avatarCropContainerSize / (2 * z));
    avatarCropDX = Math.min(maxDx, Math.max(-maxDx, avatarCropDX));
    avatarCropDY = Math.min(maxDy, Math.max(-maxDy, avatarCropDY));
}

function applyAvatarCropTransform() {
    if (!avatarCropImgEl) return;
    avatarCropImgEl.style.transform = `translate(-50%, -50%) scale(${avatarCropZoom}) translate(${avatarCropDX}px, ${avatarCropDY}px)`;
}

function setAvatarCropZoom(newZoom) {
    avatarCropZoom = Math.min(AVATAR_CROP_MAX_ZOOM, Math.max(AVATAR_CROP_MIN_ZOOM, newZoom));
    clampAvatarCropOffset();
    applyAvatarCropTransform();
}

function setupAvatarCropDragHandlers() {
    const viewport = $("avatarCropViewport");
    if (!viewport || viewport.dataset.bound) return;
    viewport.dataset.bound = "1";

    viewport.addEventListener("pointerdown", e => {
        if (!avatarCropImgEl) return;
        viewport.setPointerCapture(e.pointerId);
        avatarCropActivePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (avatarCropActivePointers.size === 2) {
            // Two fingers down: switch to pinch-to-zoom, stop single-finger panning.
            avatarCropDragging = false;
            const pts = [...avatarCropActivePointers.values()];
            avatarCropPinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            avatarCropPinchStartZoom = avatarCropZoom;
        } else if (avatarCropActivePointers.size === 1) {
            avatarCropDragging = true;
            viewport.classList.add("dragging");
            avatarCropDragStart = { x: e.clientX, y: e.clientY };
            avatarCropStartOffset = { x: avatarCropDX, y: avatarCropDY };
        }
    });

    viewport.addEventListener("pointermove", e => {
        if (!avatarCropActivePointers.has(e.pointerId)) return;
        avatarCropActivePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (avatarCropActivePointers.size === 2) {
            const pts = [...avatarCropActivePointers.values()];
            const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            if (avatarCropPinchStartDist > 0) {
                setAvatarCropZoom(avatarCropPinchStartZoom * (dist / avatarCropPinchStartDist));
            }
            return;
        }

        if (!avatarCropDragging) return;
        const dx = (e.clientX - avatarCropDragStart.x) / avatarCropZoom;
        const dy = (e.clientY - avatarCropDragStart.y) / avatarCropZoom;
        avatarCropDX = avatarCropStartOffset.x + dx;
        avatarCropDY = avatarCropStartOffset.y + dy;
        clampAvatarCropOffset();
        applyAvatarCropTransform();
    });

    const releasePointer = e => {
        avatarCropActivePointers.delete(e.pointerId);
        if (avatarCropActivePointers.size < 2) avatarCropPinchStartDist = 0;
        if (avatarCropActivePointers.size === 1) {
            // One finger remains after a pinch: resume panning from its current spot, no jump.
            const [remaining] = avatarCropActivePointers.values();
            avatarCropDragStart = { x: remaining.x, y: remaining.y };
            avatarCropStartOffset = { x: avatarCropDX, y: avatarCropDY };
            avatarCropDragging = true;
        } else {
            avatarCropDragging = false;
            viewport.classList.remove("dragging");
        }
    };
    viewport.addEventListener("pointerup", releasePointer);
    viewport.addEventListener("pointercancel", releasePointer);
    viewport.addEventListener("pointerleave", releasePointer);

    viewport.addEventListener("wheel", e => {
        if (!avatarCropImgEl) return;
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.05 : 0.05;
        setAvatarCropZoom(avatarCropZoom + delta);
    }, { passive: false });
}

function saveAvatarCrop() {
    const viewport = $("avatarCropViewport");
    const img = avatarCropImgEl;
    if (!img || !img.complete) return;
    const vRect = viewport.getBoundingClientRect();
    const iRect = img.getBoundingClientRect();
    const scaleFactor = iRect.width / avatarCropNaturalW;
    const srcX = (vRect.left - iRect.left) / scaleFactor;
    const srcY = (vRect.top - iRect.top) / scaleFactor;
    const srcSize = vRect.width / scaleFactor;
    const OUT = 320;
    const canvas = document.createElement("canvas");
    canvas.width = OUT;
    canvas.height = OUT;
    canvas.getContext("2d").drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, OUT, OUT);
    profile.avatar = canvas.toDataURL("image/jpeg", 0.9);
    profile.avatarSource = avatarCropSourceDataUrl;
    profile.avatarCrop = { zoom: avatarCropZoom, dx: avatarCropDX, dy: avatarCropDY };
    save("Profile", profile);
    renderProfile();
    closeAvatarCrop();
}

function openProfilePage() { openToolPage("profileInfo"); }

function renderSchoolInfo() {
    const name = schoolInfo.name || "";
    const abbr = schoolInfo.abbr || "";
    const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };
    setText("schoolSmallTitle", name ? name.toUpperCase() : "YOUR SCHOOL");
    setText("schoolLogoAbbr", abbr || "—");
    setText("schoolNameHome", name || "Add your school in Settings");
    setText("settingsProfileSchool", name || "Add your school");
    setText("profileInfoSchool", name || "Add your school");
    setText("homeSubtitle", abbr ? `Everything you need for ${abbr}.` : "Everything you need, all in one place.");
}

const COLLEGE_GRADES = ["Freshman", "Sophomore", "Junior", "Senior", "Graduate"];

function toggleSchoolMajorField() {
    const grade = $("editSchoolGrade").value;
    const group = $("schoolMajorFieldGroup");
    group.style.display = COLLEGE_GRADES.includes(grade) ? "block" : "none";
}

function openSchoolInfoModal() {
    $("editSchoolName").value = schoolInfo.name || "";
    $("editSchoolAbbr").value = schoolInfo.abbr || "";
    $("editSchoolGrade").value = profile.grade || "";
    $("editSchoolMajor").value = profile.major || "";
    toggleSchoolMajorField();
    openModal("schoolInfoModal");
}


function saveSchoolInfo() {
    const name = $("editSchoolName").value.trim();
    const abbr = $("editSchoolAbbr").value.trim();
    profile.grade = $("editSchoolGrade").value;
    profile.major = COLLEGE_GRADES.includes(profile.grade) ? $("editSchoolMajor").value.trim() : "";
    save("Profile", profile);
    schoolInfo.name = name;
    schoolInfo.abbr = abbr;
    save("SchoolInfo", schoolInfo);
    renderSchoolInfo();
    renderProfile();
    closeModal('schoolInfoModal');
}

function openProfileModal() {
    $("editName").value = profile.name || "";
    $("editBirthday").value = profile.birthday || "";
    $("editMEID").value = profile.meid || "";
    $("editEmail").value = profile.email || "";
    $("editPhone").value = profile.phone || "";
    openModal("profileModal");
}

function openGPAProfileModal() {
    $("editCurrentGPA").value = profile.currentGPA !== "" && profile.currentGPA != null ? Number(profile.currentGPA).toFixed(2) : "";
    openModal("gpaProfileModal");
}


function saveCurrentGPA() {
    const raw = $("editCurrentGPA").value.trim();
    if (raw === "") {
        profile.currentGPA = "";
    } else {
        const num = parseFloat(raw);
        if (isNaN(num) || num < 0 || num > 4) {
            alert("Please enter a GPA from 0.00 to 4.00.");
            return;
        }
        profile.currentGPA = num.toFixed(2);
    }
    save("Profile", profile);
    renderProfile();
    closeModal('gpaProfileModal');
}

function clearCurrentGPA() {
    profile.currentGPA = "";
    save("Profile", profile);
    renderProfile();
    closeModal('gpaProfileModal');
}

function saveProfile() {
    profile.name = $("editName").value.trim() || "Student";
    profile.birthday = $("editBirthday").value;
    profile.meid = $("editMEID").value.trim();
    profile.email = $("editEmail").value.trim();
    profile.phone = $("editPhone").value.trim();
    save("Profile", profile);
    renderProfile();
    closeModal('profileModal');
}

/* ===== CLASSES ===== */
function renderClasses() {
    const container = $("classList");
    container.innerHTML = "";
    if (classes.length === 0) {
        container.innerHTML = `<div class="profile-card static"><div style="font-size:40px;">📚</div><div style="font-size:18px;font-weight:700;margin-top:10px;">No Classes Yet</div><div style="color:var(--secondary);font-size:13px;margin-top:5px;">Add your first class below.</div></div>`;
        return;
    }
    classes.forEach(c => {
        const card = document.createElement("div");
        card.className = "class-card";
        card.onclick = () => openClassModal(c.id);
        let details = c.days;
        if (c.start || c.end) details += " · " + formatTime(c.start) + " – " + formatTime(c.end);
        card.innerHTML = `
        <div class="class-name">${escapeHTML(c.name)}</div>
        <div class="class-code">${escapeHTML(c.code)}</div>
        <div class="class-details">${escapeHTML(details)}</div>
        <div class="class-grade">${escapeHTML(c.grade || "—")}</div>
        ${c.room ? `<div class="class-room">${escapeHTML(c.room)}</div>` : ""}
      `;
        container.appendChild(card);
    });
}

function openClassModal(id = null) {
    editingClassID = id;
    const fields = ["editClassName", "editClassCode", "editClassDays", "editClassStart", "editClassEnd", "editClassRoom", "editClassGrade", "editClassNotes"];
    $$(".class-day-button").forEach(b => b.classList.remove("selected"));
    if (id === null) {
        $("classModalTitle").textContent = "Add Class";
        fields.forEach(f => $(f).value = "");
        $("editClassGrade").value = "N/A";
        $("deleteClassButton").style.display = "none";
    } else {
        const c = classes.find(item => item.id === id);
        if (!c) return;
        $("classModalTitle").textContent = "Edit Class";
        $("editClassName").value = c.name;
        $("editClassCode").value = c.code;
        $("editClassDays").value = c.days;
        $("editClassStart").value = c.start;
        $("editClassEnd").value = c.end;
        $("editClassRoom").value = c.room;
        $("editClassGrade").value = c.grade;
        $("editClassNotes").value = c.notes;
        (c.days || "").split(/,\s*|\s*&\s*/).forEach(day => {
            const btn = document.querySelector(`.class-day-button[data-day="${day.trim()}"]`);
            if (btn) btn.classList.add("selected");
        });
        $("deleteClassButton").style.display = "block";
    }
    openModal("classModal");
}

function toggleClassDay(button) {
    button.classList.toggle("selected");
    updateSelectedClassDays();
}

function updateSelectedClassDays() {
    const days = Array.from($$(".class-day-button.selected")).map(b => b.dataset.day);
    let formatted = "";
    if (days.length === 1) formatted = days[0];
    else if (days.length === 2) formatted = `${days[0]} & ${days[1]}`;
    else if (days.length > 2) formatted = days.join(", ");
    $("editClassDays").value = formatted;
}


function saveClass() {
    const classData = {
        name: $("editClassName").value.trim(),
        code: $("editClassCode").value.trim(),
        days: $("editClassDays").value.trim(),
        start: $("editClassStart").value,
        end: $("editClassEnd").value,
        room: $("editClassRoom").value.trim(),
        grade: $("editClassGrade").value.trim(),
        notes: $("editClassNotes").value.trim()
    };
    if (!classData.name) { alert("Please enter a class name."); return; }
    if (editingClassID === null) {
        classData.id = Date.now();
        classes.push(classData);
    } else {
        const i = classes.findIndex(item => item.id === editingClassID);
        if (i !== -1) classes[i] = { ...classes[i], ...classData };
    }
    save("Classes", classes);
    renderClasses();
    closeModal('classModal');
}

function deleteCurrentClass() {
    if (editingClassID === null) return;
    if (!confirm("Delete this class?")) return;
    classes = classes.filter(item => item.id !== editingClassID);
    save("Classes", classes);
    renderClasses();
    closeModal('classModal');
}

/* ===== CALENDAR ===== */
function changeCalendarView(view) {
    calendarView = view;
    $$(".view-button").forEach(b => b.classList.remove("active"));
    $(view + "ViewButton").classList.add("active");
    renderCalendar();
}

function renderCalendar() {
    const container = $("calendarContent");
    container.innerHTML = "";
    $("calendarControls").style.display = calendarView === "agenda" ? "flex" : "none";
    if (calendarView === "month") renderMonthView(container);
    if (calendarView === "week") renderWeekView(container);
    if (calendarView === "agenda") renderAgendaView(container);
}

function renderMonthView(container) {
    const year = calendarDate.getFullYear(), month = calendarDate.getMonth();
    const monthName = calendarDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    $("calendarMonthTitle").textContent = monthName;
    const firstDay = new Date(year, month, 1), lastDay = new Date(year, month + 1, 0);
    const startingDay = firstDay.getDay(), totalDays = lastDay.getDate();
    const previousLastDay = new Date(year, month, 0).getDate();

    let html = `<div class="calendar-card">
  <div class="calendar-card-header">
    <button class="card-nav-arrow" onclick="changeCalendarPeriod(-1)">‹</button>
    <div class="calendar-card-title" onclick="goToToday()">${monthName}</div>
    <button class="card-nav-arrow" onclick="changeCalendarPeriod(1)">›</button>
  </div>
  <div class="calendar-weekdays">${"S,M,T,W,T,F,S".split(",").map(d => `<div class="calendar-weekday">${d}</div>`).join("")}</div><div class="calendar-grid">`;
    for (let i = startingDay - 1; i >= 0; i--) html += createCalendarDay(year, month - 1, previousLastDay - i, true);
    for (let day = 1; day <= totalDays; day++) html += createCalendarDay(year, month, day, false);
    const cells = startingDay + totalDays;
    const remaining = cells % 7 === 0 ? 0 : 7 - (cells % 7);
    for (let day = 1; day <= remaining; day++) html += createCalendarDay(year, month + 1, day, true);
    html += `</div></div>`;

    container.innerHTML = html;
    attachCalendarDayListeners();
}

function createCalendarDay(year, month, day, otherMonth) {
    const date = new Date(year, month, day);
    const dateKey = formatDateKey(date);
    const isToday = date.toDateString() === new Date().toDateString();
    const events = calendarEvents.filter(e => e.date === dateKey).sort((a, b) => (a.time || "").localeCompare(b.time || ""));
    const customColor = dayColors[dateKey];
    const maxChips = 2;
    const chips = events.slice(0, maxChips).map(e => `<div class="day-event-chip" style="--chip-color:${e.color}">${escapeHTML(e.title)}</div>`).join("");
    const more = events.length > maxChips ? `<div class="day-event-more">+${events.length - maxChips} more</div>` : "";

    return `
  <div class="calendar-day ${otherMonth ? "other-month" : ""} ${isToday ? "today" : ""} ${customColor ? "custom-colored" : ""}"
       data-date="${dateKey}" style="${customColor ? "--day-color:" + customColor : ""}">
    <div class="calendar-day-number">${day}</div>
    <div class="calendar-day-events">${chips}${more}</div>
    ${customColor ? `<div class="day-color-bar"></div>` : ""}
  </div>`;
}

function attachCalendarDayListeners() {
    $$(".calendar-day").forEach(day => {
        day.addEventListener("click", function () {
            openDayEventsModal(this.dataset.date);
        });
    });
}

function renderWeekView(container) {
    const current = new Date(calendarDate);
    const start = new Date(current);
    start.setDate(current.getDate() - current.getDay());
    const end = new Date(start);
    end.setDate(start.getDate() + 6);

    const rangeLabel = start.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " – " + end.toLocaleDateString("en-US", { month: "short", day: "numeric" });

    let html = `<div class="calendar-card-header">
    <button class="card-nav-arrow" onclick="changeCalendarPeriod(-1)">‹</button>
    <div class="calendar-card-title" onclick="goToToday()">${rangeLabel}</div>
    <button class="card-nav-arrow" onclick="changeCalendarPeriod(1)">›</button>
  </div>
  <div class="week-view">`;
    for (let i = 0; i < 7; i++) {
        const date = new Date(start);
        date.setDate(start.getDate() + i);
        const key = formatDateKey(date);
        const events = calendarEvents.filter(e => e.date === key);

        html += `<div class="week-day-card" onclick="openCalendarModal(null,'${key}')">
    <div class="week-day-header">
      <div class="week-day-name">${date.toLocaleDateString("en-US", { weekday: "long" })}</div>
      <div class="week-day-date">${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div>
    </div>`;

        if (events.length === 0) html += `<div style="color:var(--secondary);font-size:12px;margin-top:10px;">No events</div>`;

        events.forEach(e => {
            html += `<div class="week-event" onclick="event.stopPropagation();openCalendarModal(${e.id})">
      <div class="week-event-color" style="background:${e.color}"></div>
      <div class="week-event-info">
        <div class="week-event-title">${escapeHTML(e.title)}</div>
        <div class="week-event-time">${e.time ? formatTime(e.time) : e.type}</div>
      </div>
    </div>`;
        });

        html += `</div>`;
    }
    html += "</div>";
    container.innerHTML = html;
}

function renderAgendaView(container) {
    $("calendarMonthTitle").textContent = "Upcoming";
    const sorted = [...calendarEvents].sort((a, b) => a.date.localeCompare(b.date));

    if (sorted.length === 0) {
        container.innerHTML = `<div class="calendar-card"><div class="calendar-empty"><div class="calendar-empty-icon">📅</div>No upcoming events yet.</div></div>`;
        return;
    }

    let html = '<div class="agenda-list">';
    let lastDate = "";
    sorted.forEach(e => {
        if (e.date !== lastDate) {
            const date = new Date(e.date + "T12:00:00");
            html += `<div class="agenda-date">${date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</div>`;
            lastDate = e.date;
        }
        html += `<div class="agenda-event" onclick="openCalendarModal(${e.id})">
    <div class="agenda-event-color" style="background:${e.color}"></div>
    <div class="agenda-event-info">
      <div class="agenda-event-title">${escapeHTML(e.title)}</div>
      <div class="agenda-event-subtitle">${e.time ? formatTime(e.time) + " · " : ""}${escapeHTML(e.type)}${e.location ? " · " + escapeHTML(e.location) : ""}</div>
    </div>
    <div class="arrow">›</div>
  </div>`;
    });
    html += "</div>";
    container.innerHTML = html;
}

function changeCalendarPeriod(amount) {
    if (calendarView === "month") calendarDate.setMonth(calendarDate.getMonth() + amount);
    else calendarDate.setDate(calendarDate.getDate() + (amount * 7));
    renderCalendar();
}

function goToToday() { calendarDate = new Date(); renderCalendar(); }

/* ===== CALENDAR EVENT MODAL ===== */
function openCalendarModal(id = null, date = null) {
    editingEventID = id;
    if (id === null) {
        $("calendarModalTitle").textContent = "Add Event";
        $("editEventTitle").value = "";
        $("editEventDate").value = date || formatDateKey(calendarDate);
        $("editEventTime").value = "";
        $("editEventType").value = "Other";
        $("editEventLocation").value = "";
        $("editEventNotes").value = "";
        populateEventClassDropdown();
        selectedEventColor = "#1769c2";
        updateSelection("eventColorOptions", ".color-option", "color", selectedEventColor);
        $("deleteEventButton").style.display = "none";
    } else {
        const e = calendarEvents.find(item => item.id === id);
        if (!e) return;
        $("calendarModalTitle").textContent = "Edit Event";
        $("editEventTitle").value = e.title;
        $("editEventDate").value = e.date;
        $("editEventTime").value = e.time;
        $("editEventType").value = e.type;
        $("editEventLocation").value = e.location;
        $("editEventNotes").value = e.notes;
        populateEventClassDropdown(e.classIndex || "");
        selectedEventColor = e.color;
        updateSelection("eventColorOptions", ".color-option", "color", selectedEventColor);
        $("deleteEventButton").style.display = "block";
    }
    openModal("calendarModal");
}


function populateEventClassDropdown(selectedClass = "") {
    const select = $("editEventClass");
    if (!select) return;
    select.innerHTML = `<option value="">No Class</option>`;
    classes.forEach(c => {
        const option = document.createElement("option");
        option.value = c.id;
        option.textContent = `${c.name} · ${c.code || ""}`;
        if (String(c.id) === String(selectedClass)) option.selected = true;
        select.appendChild(option);
    });
}

function selectEventColor(element) {
    selectedEventColor = element.dataset.color;
    updateSelection("eventColorOptions", ".color-option", "color", selectedEventColor);
}

function saveCalendarEvent() {
    const eventData = {
        title: $("editEventTitle").value.trim(),
        date: $("editEventDate").value,
        time: $("editEventTime").value,
        type: $("editEventType").value,
        classIndex: $("editEventClass").value,
        location: $("editEventLocation").value.trim(),
        notes: $("editEventNotes").value.trim(),
        color: selectedEventColor
    };
    if (!eventData.title) { alert("Please enter an event title."); return; }
    if (!eventData.date) { alert("Please choose a date."); return; }
    if (editingEventID === null) {
        eventData.id = Date.now();
        calendarEvents.push(eventData);
    } else {
        const i = calendarEvents.findIndex(e => e.id === editingEventID);
        if (i !== -1) calendarEvents[i] = { ...calendarEvents[i], ...eventData };
    }
    save("CalendarEvents", calendarEvents);
    renderCalendar();
    closeModal('calendarModal');
}

function deleteCalendarEvent() {
    if (editingEventID === null) return;
    if (!confirm("Delete this event?")) return;
    calendarEvents = calendarEvents.filter(e => e.id !== editingEventID);
    save("CalendarEvents", calendarEvents);
    renderCalendar();
    closeModal('calendarModal');
}

/* ===== DAY EVENTS MODAL ===== */
function openDayEventsModal(dateKey) {
    selectedDayForColor = dateKey;

    const date = new Date(dateKey + "T12:00:00");
    $("dayEventsTitle").textContent = date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

    const events = calendarEvents.filter(e => e.date === dateKey).sort((a, b) => (a.time || "").localeCompare(b.time || ""));
    const list = $("dayEventsList");

    if (events.length === 0) {
        list.innerHTML = `<div class="calendar-empty"><div class="calendar-empty-icon">📅</div>No events on this day.</div>`;
    } else {
        list.innerHTML = events.map(e => `
    <div class="agenda-event" onclick="closeModal('dayEventsModal');openCalendarModal(${e.id})">
      <div class="agenda-event-color" style="background:${e.color}"></div>
      <div class="agenda-event-info">
        <div class="agenda-event-title">${escapeHTML(e.title)}</div>
        <div class="agenda-event-subtitle">${e.time ? formatTime(e.time) + " · " : ""}${escapeHTML(e.type)}${e.location ? " · " + escapeHTML(e.location) : ""}</div>
      </div>
      <div class="arrow">›</div>
    </div>
  `).join("");
    }

    openModal("dayEventsModal");
}


function addEventForSelectedDay() {
    const date = selectedDayForColor;
    closeModal('dayEventsModal');
    openCalendarModal(null, date);
}

function customizeSelectedDayColor() {
    const date = selectedDayForColor;
    closeModal('dayEventsModal');
    openDayColorModal(date);
}

/* ===== DAY COLORS ===== */
function openDayColorModal(date) {
    selectedDayForColor = date;
    openModal("dayColorModal");
}


function saveDayColor(color) {
    if (color) dayColors[selectedDayForColor] = color;
    else delete dayColors[selectedDayForColor];
    save("DayColors", dayColors);
    closeModal('dayColorModal');
    renderCalendar();
}

/* ===== HELPERS ===== */
function formatTime(time) {
    if (!time) return "";
    const [h, m] = time.split(":");
    let hours = parseInt(h);
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;
    return `${hours}:${m} ${ampm}`;
}

function formatPhone(phone) {
    if (!phone) return "";
    const digits = phone.replace(/\D/g, "");
    if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    if (digits.length === 11 && digits[0] === "1") return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    return phone;
}

function formatPhoneInputLive(event) {
    const input = event.target;
    const raw = input.value;
    const cursorPos = input.selectionStart;
    const digitsBeforeCursor = raw.slice(0, cursorPos).replace(/\D/g, "").length;
    const digits = raw.replace(/\D/g, "").slice(0, 10);
    let formatted = "";
    if (digits.length > 0) formatted += "(" + digits.slice(0, 3);
    if (digits.length >= 3) formatted += ") ";
    if (digits.length > 3) formatted += digits.slice(3, 6);
    if (digits.length >= 6) formatted += "-";
    if (digits.length > 6) formatted += digits.slice(6, 10);
    input.value = formatted;
    let count = 0, pos = formatted.length;
    if (digitsBeforeCursor === 0) {
        pos = 0;
    } else {
        for (let i = 0; i < formatted.length; i++) {
            if (/\d/.test(formatted[i])) count++;
            if (count === digitsBeforeCursor) { pos = i + 1; break; }
        }
    }
    input.setSelectionRange(pos, pos);
}

function formatDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatShortDate(dateStr) {
    const d = new Date(dateStr + "T12:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function escapeHTML(text) {
    if (!text) return "";
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/* ===== DARK MODE ===== */
function toggleDarkMode() {
    document.body.classList.toggle("dark");
    const isDark = document.body.classList.contains("dark");
    $("darkSwitch").classList.toggle("active", isDark);
    localStorage.setItem("DarkMode", isDark ? "true" : "false");
    document.querySelector('meta[name="theme-color"]').setAttribute("content", isDark ? "#101114" : "#f4f5f7");
}

function loadDarkMode() {
    if (localStorage.getItem("DarkMode") === "true") {
        document.body.classList.add("dark");
        $("darkSwitch").classList.add("active");
        document.querySelector('meta[name="theme-color"]').setAttribute("content", "#101114");
    }
}

/* ===== SIDEBAR COLLAPSE (desktop) ===== */
function toggleSidebarCollapsed() {
    document.body.classList.toggle("sidebar-collapsed");
    const collapsed = document.body.classList.contains("sidebar-collapsed");
    localStorage.setItem("SidebarCollapsed", collapsed ? "true" : "false");
    const btn = $("sidebarToggleButton");
    if (btn) {
        btn.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
        btn.setAttribute("title", collapsed ? "Expand sidebar" : "Collapse sidebar");
    }
}

function loadSidebarCollapsed() {
    if (localStorage.getItem("SidebarCollapsed") === "true") {
        document.body.classList.add("sidebar-collapsed");
        const btn = $("sidebarToggleButton");
        if (btn) {
            btn.setAttribute("aria-label", "Expand sidebar");
            btn.setAttribute("title", "Expand sidebar");
        }
    }
}

/* ===== STARTUP PAGE ===== */
function toggleDefaultToStudentVue() {
    const enabled = localStorage.getItem("DefaultToStudentVue") !== "true";
    localStorage.setItem("DefaultToStudentVue", enabled ? "true" : "false");
    $("defaultToStudentVueSwitch").classList.toggle("active", enabled);
}

function loadDefaultToStudentVuePref() {
    if (localStorage.getItem("DefaultToStudentVue") === "true") {
        $("defaultToStudentVueSwitch").classList.add("active");
    }
}

// Defaults to ON (matches the app's original always-auto-fetch
// behavior) — only an explicit "false" turns it off, so people who
// never visit this setting see no change.
function svAutoLoginEnabled() {
    return localStorage.getItem("StudentVueAutoLogin") !== "false";
}

function toggleSvAutoLogin() {
    const enabled = !svAutoLoginEnabled();
    localStorage.setItem("StudentVueAutoLogin", enabled ? "true" : "false");
    $("svAutoLoginSwitch").classList.toggle("active", enabled);
}

function loadSvAutoLoginPref() {
    if (svAutoLoginEnabled()) {
        $("svAutoLoginSwitch").classList.add("active");
    }
}

// Called once at startup (after everything else has rendered) to skip
// Home and jump straight into StudentVUE, if the person turned that on
// in Settings. Mirrors what happens when someone taps Tools then
// StudentVUE by hand: the Tools nav button stays highlighted as the
// "section" they're in, and openStudentVue() takes care of showing
// cached data immediately and refreshing in the background.
function applyDefaultStartupPage() {
    if (localStorage.getItem("DefaultToStudentVue") !== "true") return;
    $$(".nav-button").forEach(n => n.classList.remove("active"));
    const toolsBtn = $("navToolsButton");
    if (toolsBtn) toolsBtn.classList.add("active");
    openStudentVue();
}

/* ===== PROJECTS & TO-DOS ===== */
function openTodos() {
    openToolPage("todos");
    currentProjectID = null;
    $("projectDetailView").style.display = "none";
    $("projectListView").style.display = "block";
    $("todosEditButton").style.display = "none";
    $("todosPageTitle").textContent = "Projects";
    renderProjectList();
}

function closeTodos() {
    showToolsFromTool();
}

function handleTodosBackClick() {
    if (currentProjectID !== null) {
        currentProjectID = null;
        $("projectDetailView").style.display = "none";
        $("projectListView").style.display = "block";
        $("todosEditButton").style.display = "none";
        $("todosPageTitle").textContent = "Projects";
        renderProjectList();
    } else {
        closeTodos();
    }
}

function handleTodosAddClick() {
    if (currentProjectID !== null) openTaskModal();
    else openProjectModal();
}

function renderProjectList() {
    const container = $("projectList");
    container.innerHTML = "";
    if (projects.length === 0) {
        container.innerHTML = `<div class="profile-card static"><div style="font-size:40px;">✅</div><div style="font-size:18px;font-weight:700;margin-top:10px;">No Projects Yet</div><div style="color:var(--secondary);font-size:13px;margin-top:5px;">Create a project to start tracking tasks.</div></div>`;
        return;
    }
    projects.forEach(p => {
        const total = p.tasks.length;
        const done = p.tasks.filter(t => t.status === "done").length;
        const pct = total ? Math.round((done / total) * 100) : 0;
        const card = document.createElement("div");
        card.className = "class-card";
        card.style.minHeight = "auto";
        card.onclick = () => openProjectDetail(p.id);
        card.innerHTML = `
    <div style="display:flex;align-items:center;gap:9px;">
      <div style="width:12px;height:12px;border-radius:50%;background:${p.color};flex-shrink:0;"></div>
      <div class="class-name" style="padding-right:0;font-size:17px;">${escapeHTML(p.name)}</div>
    </div>
    <div class="class-code" style="margin-top:8px;">${total} task${total === 1 ? "" : "s"} · ${done} done</div>
    <div class="progress-bar-track"><div class="progress-bar-fill" style="width:${pct}%;background:${p.color}"></div></div>
  `;
        container.appendChild(card);
    });
}

function openProjectDetail(id) {
    currentProjectID = id;
    const p = projects.find(pr => pr.id === id);
    if (!p) return;
    $("projectListView").style.display = "none";
    $("projectDetailView").style.display = "block";
    $("todosEditButton").style.display = "flex";
    $("todosPageTitle").textContent = p.name;
    renderKanbanBoard();
}

function renderKanbanBoard() {
    const p = projects.find(pr => pr.id === currentProjectID);
    const board = $("kanbanBoard");
    if (!p) { board.innerHTML = ""; return; }
    const columns = [
        { key: "todo", label: "To Do" },
        { key: "inprogress", label: "In Progress" },
        { key: "done", label: "Done" }
    ];
    board.innerHTML = columns.map(col => {
        const tasks = p.tasks.filter(t => t.status === col.key).sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
        const taskHTML = tasks.length === 0
            ? `<div class="kanban-empty">No tasks</div>`
            : tasks.map(t => {
                const overdue = t.due && t.due < formatDateKey(new Date()) && col.key !== "done";
                return `
        <div class="task-card" onclick="openTaskModal(${t.id})">
          <div class="task-card-top">
            <div class="task-priority-dot" style="background:${priorityColor(t.priority)}"></div>
            <div class="task-title">${escapeHTML(t.title)}</div>
            ${t.image ? `<img src="${t.image}" style="width:22px;height:22px;border-radius:5px;object-fit:cover;flex-shrink:0;" alt="">` : ""}
          </div>
          ${t.due ? `<div class="task-due ${overdue ? "overdue" : ""}">Due ${formatShortDate(t.due)}</div>` : ""}
        </div>`;
            }).join("");
        return `
    <div class="kanban-column">
      <div class="kanban-column-header"><span>${col.label}</span><span class="kanban-count">${tasks.length}</span></div>
      <div class="kanban-tasks">${taskHTML}</div>
    </div>`;
    }).join("");
}

function priorityColor(priority) {
    return priority === "high" ? "#ff3b30" : priority === "low" ? "#34c759" : "#ff9500";
}

/* Project modal */
function openProjectModal(id = null) {
    editingProjectID = id;
    if (id === null) {
        $("projectModalTitle").textContent = "Add Project";
        $("editProjectName").value = "";
        selectedProjectColor = "#1769c2";
        $("deleteProjectButton").style.display = "none";
    } else {
        const p = projects.find(pr => pr.id === id);
        if (!p) return;
        $("projectModalTitle").textContent = "Edit Project";
        $("editProjectName").value = p.name;
        selectedProjectColor = p.color;
        $("deleteProjectButton").style.display = "block";
    }
    updateSelection("projectColorOptions", ".color-option", "color", selectedProjectColor);
    openModal("projectModal");
}


function selectProjectColor(el) { selectedProjectColor = el.dataset.color; updateSelection("projectColorOptions", ".color-option", "color", selectedProjectColor); }

function saveProject() {
    const name = $("editProjectName").value.trim();
    if (!name) { alert("Please enter a project name."); return; }
    if (editingProjectID === null) {
        projects.push({ id: Date.now(), name, color: selectedProjectColor, tasks: [] });
    } else {
        const i = projects.findIndex(p => p.id === editingProjectID);
        if (i !== -1) { projects[i].name = name; projects[i].color = selectedProjectColor; }
    }
    save("Projects", projects);
    closeModal('projectModal');
    if (currentProjectID !== null) {
        $("todosPageTitle").textContent = name;
        renderKanbanBoard();
    } else {
        renderProjectList();
    }
}

function deleteCurrentProject() {
    if (editingProjectID === null) return;
    if (!confirm("Delete this project and all its tasks?")) return;
    projects = projects.filter(p => p.id !== editingProjectID);
    save("Projects", projects);
    closeModal('projectModal');
    currentProjectID = null;
    $("projectDetailView").style.display = "none";
    $("projectListView").style.display = "block";
    $("todosEditButton").style.display = "none";
    $("todosPageTitle").textContent = "Projects";
    renderProjectList();
}

/* Task modal */
function openTaskModal(id = null) {
    const p = projects.find(pr => pr.id === currentProjectID);
    if (!p) return;
    editingTaskID = id;
    if (id === null) {
        $("taskModalTitle").textContent = "Add Task";
        $("editTaskTitle").value = "";
        $("editTaskDue").value = "";
        $("editTaskNotes").value = "";
        selectedTaskStatus = "todo";
        selectedTaskPriority = "medium";
        pendingTaskImage = null;
        $("deleteTaskButton").style.display = "none";
    } else {
        const t = p.tasks.find(task => task.id === id);
        if (!t) return;
        $("taskModalTitle").textContent = "Edit Task";
        $("editTaskTitle").value = t.title;
        $("editTaskDue").value = t.due || "";
        $("editTaskNotes").value = t.notes || "";
        selectedTaskStatus = t.status;
        selectedTaskPriority = t.priority;
        pendingTaskImage = t.image || null;
        $("deleteTaskButton").style.display = "block";
    }
    updateSelection("taskStatusButtons", ".class-day-button", "status", selectedTaskStatus);
    updateSelection("taskPriorityButtons", ".class-day-button", "priority", selectedTaskPriority);
    $("taskImagePreviewWrap").style.display = pendingTaskImage ? "block" : "none";
    if (pendingTaskImage) $("taskImagePreview").src = pendingTaskImage;
    openModal("taskModal");
}

async function handleTaskImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    pendingTaskImage = await resizeImageFile(file, 800);
    $("taskImagePreview").src = pendingTaskImage;
    $("taskImagePreviewWrap").style.display = "block";
    event.target.value = "";
}

function removeTaskImage() {
    pendingTaskImage = null;
    $("taskImagePreviewWrap").style.display = "none";
}

function selectTaskStatus(el) { selectedTaskStatus = el.dataset.status; updateSelection("taskStatusButtons", ".class-day-button", "status", selectedTaskStatus); }
function selectTaskPriority(el) { selectedTaskPriority = el.dataset.priority; updateSelection("taskPriorityButtons", ".class-day-button", "priority", selectedTaskPriority); }

function saveTask() {
    const title = $("editTaskTitle").value.trim();
    if (!title) { alert("Please enter a task title."); return; }
    const p = projects.find(pr => pr.id === currentProjectID);
    if (!p) return;
    const taskData = {
        title,
        status: selectedTaskStatus,
        priority: selectedTaskPriority,
        due: $("editTaskDue").value,
        notes: $("editTaskNotes").value.trim(),
        image: pendingTaskImage
    };
    if (editingTaskID === null) {
        taskData.id = Date.now();
        p.tasks.push(taskData);
    } else {
        const i = p.tasks.findIndex(t => t.id === editingTaskID);
        if (i !== -1) p.tasks[i] = { ...p.tasks[i], ...taskData };
    }
    save("Projects", projects);
    closeModal('taskModal');
    renderKanbanBoard();
}

function deleteCurrentTask() {
    if (editingTaskID === null) return;
    if (!confirm("Delete this task?")) return;
    const p = projects.find(pr => pr.id === currentProjectID);
    if (!p) return;
    p.tasks = p.tasks.filter(t => t.id !== editingTaskID);
    save("Projects", projects);
    closeModal('taskModal');
    renderKanbanBoard();
}

/* ===== STUDY SETS (FLASHCARDS & QUIZ) ===== */
function openStudySets() {
    openToolPage("studysets");
    currentSetID = null;
    $("setDetailView").style.display = "none";
    $("setListView").style.display = "block";
    $("studySetsEditButton").style.display = "none";
    $("studySetsPageTitle").textContent = "Study Sets";
    renderSetList();
}

function handleStudySetsBackClick() {
    if (currentSetID !== null) {
        currentSetID = null;
        $("setDetailView").style.display = "none";
        $("setListView").style.display = "block";
        $("studySetsEditButton").style.display = "none";
        $("studySetsPageTitle").textContent = "Study Sets";
        renderSetList();
    } else {
        showToolsFromTool();
    }
}

function handleStudySetsAddClick() {
    if (currentSetID !== null) openCardModal();
    else openSetModal();
}

function renderSetList() {
    const container = $("setList");
    container.innerHTML = "";
    if (studySets.length === 0) {
        container.innerHTML = `<div class="profile-card static"><div style="font-size:40px;">🧠</div><div style="font-size:18px;font-weight:700;margin-top:10px;">No Study Sets Yet</div><div style="color:var(--secondary);font-size:13px;margin-top:5px;">Create a set to start making flashcards.</div></div>`;
        return;
    }
    studySets.forEach(s => {
        const card = document.createElement("div");
        card.className = "class-card";
        card.style.minHeight = "auto";
        card.onclick = () => openSetDetail(s.id);
        card.innerHTML = `
    <div style="display:flex;align-items:center;gap:9px;">
      <div style="width:12px;height:12px;border-radius:50%;background:${s.color};flex-shrink:0;"></div>
      <div class="class-name" style="padding-right:0;font-size:17px;">${escapeHTML(s.name)}</div>
    </div>
    <div class="class-code" style="margin-top:8px;">${s.cards.length} card${s.cards.length === 1 ? "" : "s"}</div>
  `;
        container.appendChild(card);
    });
}

function openSetDetail(id) {
    currentSetID = id;
    const s = studySets.find(st => st.id === id);
    if (!s) return;
    $("setListView").style.display = "none";
    $("setDetailView").style.display = "block";
    $("studySetsEditButton").style.display = "flex";
    $("studySetsPageTitle").textContent = s.name;
    renderCardList();
}

function renderCardList() {
    const s = studySets.find(st => st.id === currentSetID);
    const container = $("cardList");
    if (!s) { container.innerHTML = ""; return; }
    if (s.cards.length === 0) {
        container.innerHTML = `<div class="profile-card static"><div style="font-size:36px;">🗂️</div><div style="font-size:16px;font-weight:700;margin-top:8px;">No Cards Yet</div><div style="color:var(--secondary);font-size:13px;margin-top:5px;">Add a card to get started.</div></div>`;
        return;
    }
    container.innerHTML = s.cards.map(c => `
  <div class="class-card" style="min-height:auto;padding:16px;${c.image ? "display:flex;align-items:center;gap:12px;" : ""}" onclick="openCardModal(${c.id})">
    ${c.image ? `<img src="${c.image}" style="width:48px;height:48px;border-radius:10px;object-fit:cover;flex-shrink:0;" alt="">` : ""}
    <div>
      <div style="font-weight:700;font-size:15px;">${escapeHTML(c.front)}</div>
      <div style="color:var(--secondary);font-size:13px;margin-top:6px;">${escapeHTML(c.back)}</div>
    </div>
  </div>
`).join("");
}

function openSetModal(id = null) {
    editingSetID = id;
    if (id === null) {
        $("setModalTitle").textContent = "Add Study Set";
        $("editSetName").value = "";
        selectedSetColor = "#1769c2";
        $("deleteSetButton").style.display = "none";
    } else {
        const s = studySets.find(st => st.id === id);
        if (!s) return;
        $("setModalTitle").textContent = "Edit Study Set";
        $("editSetName").value = s.name;
        selectedSetColor = s.color;
        $("deleteSetButton").style.display = "block";
    }
    updateSelection("setColorOptions", ".color-option", "color", selectedSetColor);
    openModal("setModal");
}

function selectSetColor(el) { selectedSetColor = el.dataset.color; updateSelection("setColorOptions", ".color-option", "color", selectedSetColor); }

function saveSet() {
    const name = $("editSetName").value.trim();
    if (!name) { alert("Please enter a set name."); return; }
    if (editingSetID === null) {
        studySets.push({ id: Date.now(), name, color: selectedSetColor, cards: [] });
    } else {
        const i = studySets.findIndex(s => s.id === editingSetID);
        if (i !== -1) { studySets[i].name = name; studySets[i].color = selectedSetColor; }
    }
    save("StudySets", studySets);
    closeModal('setModal');
    if (currentSetID !== null) {
        $("studySetsPageTitle").textContent = name;
        renderCardList();
    } else {
        renderSetList();
    }
}

function deleteCurrentSet() {
    if (editingSetID === null) return;
    if (!confirm("Delete this study set and all its cards?")) return;
    studySets = studySets.filter(s => s.id !== editingSetID);
    save("StudySets", studySets);
    closeModal('setModal');
    currentSetID = null;
    $("setDetailView").style.display = "none";
    $("setListView").style.display = "block";
    $("studySetsEditButton").style.display = "none";
    $("studySetsPageTitle").textContent = "Study Sets";
    renderSetList();
}

function openCardModal(id = null) {
    const s = studySets.find(st => st.id === currentSetID);
    if (!s) return;
    editingCardID = id;
    if (id === null) {
        $("cardModalTitle").textContent = "Add Card";
        $("editCardFront").value = "";
        $("editCardBack").value = "";
        $("editCardCorrectAnswers").value = "";
        $("editCardExtraOptions").value = "";
        pendingCardImage = null;
        $("deleteCardButton").style.display = "none";
    } else {
        const c = s.cards.find(card => card.id === id);
        if (!c) return;
        $("cardModalTitle").textContent = "Edit Card";
        $("editCardFront").value = c.front;
        $("editCardBack").value = c.back;
        $("editCardCorrectAnswers").value = Array.isArray(c.correctAnswers) ? c.correctAnswers.join("\n") : "";
        $("editCardExtraOptions").value = Array.isArray(c.extraOptions) ? c.extraOptions.join("\n") : "";
        pendingCardImage = c.image || null;
        $("deleteCardButton").style.display = "block";
    }
    $("cardImagePreviewWrap").style.display = pendingCardImage ? "block" : "none";
    if (pendingCardImage) $("cardImagePreview").src = pendingCardImage;
    openModal("cardModal");
}

async function handleCardImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    pendingCardImage = await resizeImageFile(file, 800);
    $("cardImagePreview").src = pendingCardImage;
    $("cardImagePreviewWrap").style.display = "block";
    event.target.value = "";
}

function removeCardImage() {
    pendingCardImage = null;
    $("cardImagePreviewWrap").style.display = "none";
}

function saveCard() {
    const front = $("editCardFront").value.trim();
    const back = $("editCardBack").value.trim();
    const correctAnswers = $("editCardCorrectAnswers").value.split("\n").map(v => v.trim()).filter(Boolean);
    const extraOptions = $("editCardExtraOptions").value.split("\n").map(v => v.trim()).filter(Boolean);
    if (!front || !back) { alert("Please fill in both sides of the card."); return; }
    const s = studySets.find(st => st.id === currentSetID);
    if (!s) return;
    if (editingCardID === null) {
        s.cards.push({ id: Date.now(), front, back, correctAnswers, extraOptions, image: pendingCardImage });
    } else {
        const i = s.cards.findIndex(c => c.id === editingCardID);
        if (i !== -1) s.cards[i] = { ...s.cards[i], front, back, correctAnswers, extraOptions, image: pendingCardImage };
    }
    save("StudySets", studySets);
    closeModal('cardModal');
    renderCardList();
}

function deleteCurrentCard() {
    if (editingCardID === null) return;
    if (!confirm("Delete this card?")) return;
    const s = studySets.find(st => st.id === currentSetID);
    if (!s) return;
    s.cards = s.cards.filter(c => c.id !== editingCardID);
    save("StudySets", studySets);
    closeModal('cardModal');
    renderCardList();
}

/* Study (flashcard) mode */
function startStudyMode() {
    const s = studySets.find(st => st.id === currentSetID);
    if (!s || s.cards.length === 0) { alert("Add some cards first."); return; }
    studyModeCards = [...s.cards];
    studyModeIndex = 0;
    renderStudyCard();
    openModal("studyModal");
}


function renderStudyCard() {
    const c = studyModeCards[studyModeIndex];
    $("flipCardFront").innerHTML = (c.image ? `<img src="${c.image}" style="max-width:100%;max-height:120px;border-radius:10px;object-fit:cover;margin-bottom:10px;" alt="">` : "") + escapeHTML(c.front);
    $("flipCardBack").textContent = c.back;
    $("flipCardInner").classList.remove("flipped");
    $("studyProgress").textContent = `Card ${studyModeIndex + 1} of ${studyModeCards.length} · Tap to flip`;
}

function flipStudyCard() { $("flipCardInner").classList.toggle("flipped"); }

function nextStudyCard() {
    studyModeIndex = (studyModeIndex + 1) % studyModeCards.length;
    renderStudyCard();
}

function prevStudyCard() {
    studyModeIndex = (studyModeIndex - 1 + studyModeCards.length) % studyModeCards.length;
    renderStudyCard();
}

function shuffleStudyCards() {
    shuffleArray(studyModeCards);
    studyModeIndex = 0;
    renderStudyCard();
}

/* Quiz mode */
function startQuizMode() {
    const s = studySets.find(st => st.id === currentSetID);
    if (!s || s.cards.length < 2) { alert("Add at least 2 cards to take a quiz."); return; }
    quizQuestions = shuffleArray([...s.cards]);
    quizIndex = 0;
    quizScore = 0;
    quizAnswered = false;
    quizSelectedAnswers = [];
    renderQuizQuestion();
    openModal("quizModal");
}


function getQuizCorrectAnswers(card) {
    const answers = Array.isArray(card.correctAnswers) ? card.correctAnswers.filter(Boolean) : [];
    return answers.length ? answers : [card.back];
}

function renderQuizQuestion() {
    const content = $("quizContent");
    if (quizIndex >= quizQuestions.length) {
        const pct = Math.round((quizScore / quizQuestions.length) * 100);
        $("quizProgress").textContent = "Complete!";
        content.innerHTML = `
        <div class="quiz-score">
          <div class="quiz-score-number">${quizScore}/${quizQuestions.length}</div>
          <div style="color:var(--secondary);margin-top:6px;">${pct}% correct</div>
        </div>
        <button class="primary-button" onclick="startQuizMode()">Retake Quiz</button>
        <button class="secondary-button" onclick="closeModal('quizModal')">Done</button>
      `;
        return;
    }

    quizAnswered = false;
    quizSelectedAnswers = [];
    const q = quizQuestions[quizIndex];
    const s = studySets.find(st => st.id === currentSetID);
    const correctAnswers = getQuizCorrectAnswers(q);
    const customWrongOptions = Array.isArray(q.extraOptions) ? q.extraOptions : [];
    const fallbackWrongPool = s.cards
        .filter(c => c.id !== q.id)
        .flatMap(c => getQuizCorrectAnswers(c));
    const uniqueWrong = [...new Set([...customWrongOptions, ...shuffleArray(fallbackWrongPool)])]
        .filter(opt => !correctAnswers.includes(opt));
    const wrongCount = Math.max(0, 4 - correctAnswers.length);
    const wrongs = uniqueWrong.slice(0, Math.min(3, wrongCount));
    const options = shuffleArray([...correctAnswers, ...wrongs]);
    const multiple = correctAnswers.length > 1;

    $("quizProgress").textContent = `Question ${quizIndex + 1} of ${quizQuestions.length}`;
    content.innerHTML = `
      <div class="quiz-question">${escapeHTML(q.front)}</div>
      ${multiple ? `<div class="quiz-help" style="text-align:center;margin-bottom:10px;">Select all correct answers, then tap Submit.</div>` : ""}
      <div id="quizOptions"></div>
      ${multiple ? `<button class="primary-button" id="quizSubmitButton" onclick="submitMultipleQuizAnswer()">Submit Answer</button>` : ""}
    `;

    const optionsContainer = $("quizOptions");
    options.forEach((opt, index) => {
        if (multiple) {
            const row = document.createElement("label");
            row.className = "quiz-check-row";
            row.innerHTML = `<input type="checkbox" value="${escapeHTML(opt)}"><span>${escapeHTML(opt)}</span>`;
            const checkbox = row.querySelector("input");
            checkbox.addEventListener("change", () => {
                row.classList.toggle("selected", checkbox.checked);
                quizSelectedAnswers = Array.from($$("#quizOptions input:checked")).map(i => i.value);
            });
            optionsContainer.appendChild(row);
        } else {
            const btn = document.createElement("button");
            btn.className = "quiz-option";
            btn.textContent = opt;
            btn.onclick = () => answerQuiz(btn, opt, correctAnswers[0]);
            optionsContainer.appendChild(btn);
        }
    });
}

function answerQuiz(button, selected, correct) {
    if (quizAnswered) return;
    quizAnswered = true;
    const allOptions = $$("#quizOptions .quiz-option");
    allOptions.forEach(o => {
        o.onclick = null;
        if (o.textContent === correct) o.classList.add("correct");
        else if (o === button) o.classList.add("incorrect");
    });
    if (selected === correct) quizScore++;
    setTimeout(() => { quizIndex++; renderQuizQuestion(); }, 900);
}

function submitMultipleQuizAnswer() {
    if (quizAnswered) return;
    quizAnswered = true;
    const q = quizQuestions[quizIndex];
    const correctAnswers = getQuizCorrectAnswers(q).slice().sort();
    const selected = Array.from($$("#quizOptions input:checked")).map(i => i.value).sort();
    const isCorrect = selected.length === correctAnswers.length &&
        selected.every((answer, i) => answer === correctAnswers[i]);

    $$("#quizOptions .quiz-check-row").forEach(row => {
        const input = row.querySelector("input");
        const value = input.value;
        if (correctAnswers.includes(value)) row.classList.add("correct");
        else if (input.checked) row.classList.add("incorrect");
        input.disabled = true;
    });
    const submit = $("quizSubmitButton");
    if (submit) submit.disabled = true;
    if (isCorrect) quizScore++;
    setTimeout(() => { quizIndex++; renderQuizQuestion(); }, 1000);
}

/* ===== GPA CALCULATOR ===== */
function openGPA() {
    openToolPage("gpa");
    renderGpaUseCurrentUI();
    renderGpaCourses();
}

function renderGpaUseCurrentUI() {
    $("gpaUseCurrentSwitch").classList.toggle("active", !!gpaSettings.useCurrent);
    $("gpaPriorCreditsRow").style.display = gpaSettings.useCurrent ? "flex" : "none";
    $("gpaUseCurrentHint").style.display = gpaSettings.useCurrent ? "block" : "none";
    $("gpaPriorCredits").value = gpaSettings.priorCredits ?? "";
}

function toggleGpaUseCurrent() {
    if (!gpaSettings.useCurrent && (profile.currentGPA === "" || profile.currentGPA == null)) {
        alert("Set your current GPA in Settings first.");
        return;
    }
    gpaSettings.useCurrent = !gpaSettings.useCurrent;
    save("GpaSettings", gpaSettings);
    renderGpaUseCurrentUI();
    renderGpaCourses();
}

function updateGpaPriorCredits() {
    const raw = $("gpaPriorCredits").value;
    const num = parseFloat(raw);
    gpaSettings.priorCredits = raw === "" ? "" : (isNaN(num) || num < 0 ? "" : num);
    save("GpaSettings", gpaSettings);
    renderGpaCourses();
}

function gradeLabel(points) {
    const map = { 4: "A", 3.7: "A-", 3.3: "B+", 3: "B", 2.7: "B-", 2.3: "C+", 2: "C", 1.7: "C-", 1.3: "D+", 1: "D", 0: "F" };
    return map[points] ?? points;
}

function renderGpaCourses() {
    const container = $("gpaCourseList");
    container.innerHTML = "";
    if (gpaCourses.length === 0) {
        container.innerHTML = `<div class="profile-card static"><div style="font-size:36px;">🎯</div><div style="font-size:16px;font-weight:700;margin-top:8px;">No Courses Added</div><div style="color:var(--secondary);font-size:13px;margin-top:5px;">Add a course to calculate your GPA.</div></div>`;
    } else {
        gpaCourses.forEach(c => {
            const btn = document.createElement("button");
            btn.className = "list-button";
            btn.onclick = () => openGpaModal(c.id);
            btn.innerHTML = `
      <div class="list-icon">${gradeLabel(c.points)}</div>
      <div class="list-info">
        <div class="list-title">${escapeHTML(c.name || "Course")}</div>
        <div class="list-subtitle">${c.credits} credit${c.credits == 1 ? "" : "s"}</div>
      </div>
      <div class="arrow">›</div>
    `;
            container.appendChild(btn);
        });
    }
    let totalPoints = 0, totalCredits = 0;
    gpaCourses.forEach(c => { totalPoints += c.points * c.credits; totalCredits += Number(c.credits); });
    if (gpaSettings.useCurrent && profile.currentGPA !== "" && profile.currentGPA != null && gpaSettings.priorCredits) {
        const priorCredits = Number(gpaSettings.priorCredits);
        totalPoints += Number(profile.currentGPA) * priorCredits;
        totalCredits += priorCredits;
    }
    const gpaValue = totalCredits > 0 ? (totalPoints / totalCredits).toFixed(2) : "0.00";
    $("gpaResult").textContent = gpaValue;
    $("gpaCreditTotal").textContent = `${totalCredits} credit hour${totalCredits == 1 ? "" : "s"}`;
}

function openGpaModal(id = null) {
    editingGpaID = id;
    if (id === null) {
        $("gpaModalTitle").textContent = "Add Course";
        $("editGpaName").value = "";
        $("editGpaCredits").value = "3";
        $("editGpaGrade").value = "4";
        $("deleteGpaButton").style.display = "none";
    } else {
        const c = gpaCourses.find(course => course.id === id);
        if (!c) return;
        $("gpaModalTitle").textContent = "Edit Course";
        $("editGpaName").value = c.name;
        $("editGpaCredits").value = c.credits;
        $("editGpaGrade").value = c.points;
        $("deleteGpaButton").style.display = "block";
    }
    openModal("gpaModal");
}


function saveGpaCourse() {
    const credits = parseFloat($("editGpaCredits").value);
    if (!credits || credits <= 0) { alert("Please enter valid credit hours."); return; }
    const data = {
        name: $("editGpaName").value.trim(),
        credits,
        points: parseFloat($("editGpaGrade").value)
    };
    if (editingGpaID === null) {
        data.id = Date.now();
        gpaCourses.push(data);
    } else {
        const i = gpaCourses.findIndex(c => c.id === editingGpaID);
        if (i !== -1) gpaCourses[i] = { ...gpaCourses[i], ...data };
    }
    save("GpaCourses", gpaCourses);
    closeModal('gpaModal');
    renderGpaCourses();
}

function deleteCurrentGpaCourse() {
    if (editingGpaID === null) return;
    if (!confirm("Delete this course?")) return;
    gpaCourses = gpaCourses.filter(c => c.id !== editingGpaID);
    save("GpaCourses", gpaCourses);
    closeModal('gpaModal');
    renderGpaCourses();
}

/* ===== STUDY TIMER ===== */
function openTimer() { openToolPage("timer"); }

function updateTimerDurations() {
    if (timerRunning) return;
    const focus = parseInt($("focusMinutes").value) || 25;
    const brk = parseInt($("breakMinutes").value) || 5;
    timerSeconds = (timerIsBreak ? brk : focus) * 60;
    renderTimerDisplay();
}

function toggleTimer() { timerRunning ? pauseTimer() : runTimer(); }

function runTimer() {
    timerRunning = true;
    $("timerStartLabel").textContent = "Pause";
    document.querySelector("#timerStartButton .icon").textContent = "⏸️";
    timerInterval = setInterval(() => {
        timerSeconds--;
        if (timerSeconds <= 0) {
            timerIsBreak = !timerIsBreak;
            if (!timerIsBreak) timerCycle++;
            const mins = timerIsBreak
                ? (parseInt($("breakMinutes").value) || 5)
                : (parseInt($("focusMinutes").value) || 25);
            timerSeconds = mins * 60;
            $("timerMode").textContent = timerIsBreak ? "BREAK TIME" : "FOCUS SESSION";
            $("timerCycleLabel").textContent = "Session " + timerCycle;
        }
        renderTimerDisplay();
    }, 1000);
}

function pauseTimer() {
    timerRunning = false;
    clearInterval(timerInterval);
    $("timerStartLabel").textContent = "Start";
    document.querySelector("#timerStartButton .icon").textContent = "▶️";
}

function resetTimer() {
    pauseTimer();
    timerIsBreak = false;
    timerCycle = 1;
    $("timerMode").textContent = "FOCUS SESSION";
    $("timerCycleLabel").textContent = "Session 1";
    timerSeconds = (parseInt($("focusMinutes").value) || 25) * 60;
    renderTimerDisplay();
}

function renderTimerDisplay() {
    const m = Math.floor(timerSeconds / 60), s = timerSeconds % 60;
    $("timerDisplay").textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* ===== NOTES ===== */
function openNotes() { openToolPage("notes"); renderNotes(); }

function renderNotes() {
    const container = $("notesList");
    container.innerHTML = "";
    if (notes.length === 0) {
        container.innerHTML = `<div class="profile-card static"><div style="font-size:36px;">🗒️</div><div style="font-size:16px;font-weight:700;margin-top:8px;">No Notes Yet</div><div style="color:var(--secondary);font-size:13px;margin-top:5px;">Add a note to jot something down.</div></div>`;
        return;
    }
    [...notes].sort((a, b) => (b.updated || 0) - (a.updated || 0)).forEach(n => {
        const btn = document.createElement("button");
        btn.className = "list-button";
        btn.onclick = () => openNoteModal(n.id);
        const icon = n.image ? `<img class="thumb-icon" src="${n.image}" alt="">` : "🗒️";
        btn.innerHTML = `
    <div class="list-icon">${icon}</div>
    <div class="list-info">
      <div class="list-title">${escapeHTML(n.title || "Untitled")}</div>
      <div class="list-subtitle">${escapeHTML((n.content || "").slice(0, 60))}${(n.content || "").length > 60 ? "…" : ""}</div>
    </div>
    <div class="arrow">›</div>
  `;
        container.appendChild(btn);
    });
}

function openNoteModal(id = null) {
    editingNoteID = id;
    if (id === null) {
        $("noteModalTitle").textContent = "Add Note";
        $("editNoteTitle").value = "";
        $("editNoteContent").value = "";
        pendingNoteImage = null;
        $("deleteNoteButton").style.display = "none";
    } else {
        const n = notes.find(note => note.id === id);
        if (!n) return;
        $("noteModalTitle").textContent = "Edit Note";
        $("editNoteTitle").value = n.title;
        $("editNoteContent").value = n.content;
        pendingNoteImage = n.image || null;
        $("deleteNoteButton").style.display = "block";
    }
    $("noteImagePreviewWrap").style.display = pendingNoteImage ? "block" : "none";
    if (pendingNoteImage) $("noteImagePreview").src = pendingNoteImage;
    openModal("noteModal");
}

async function handleNoteImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    pendingNoteImage = await resizeImageFile(file, 800);
    $("noteImagePreview").src = pendingNoteImage;
    $("noteImagePreviewWrap").style.display = "block";
    event.target.value = "";
}

function removeNoteImage() {
    pendingNoteImage = null;
    $("noteImagePreviewWrap").style.display = "none";
}

function saveNote() {
    const title = $("editNoteTitle").value.trim();
    const content = $("editNoteContent").value.trim();
    if (!title && !content) { alert("Please add a title or some content."); return; }
    if (editingNoteID === null) {
        notes.push({ id: Date.now(), title, content, image: pendingNoteImage, updated: Date.now() });
    } else {
        const i = notes.findIndex(n => n.id === editingNoteID);
        if (i !== -1) notes[i] = { ...notes[i], title, content, image: pendingNoteImage, updated: Date.now() };
    }
    save("Notes", notes);
    closeModal('noteModal');
    renderNotes();
}

function deleteCurrentNote() {
    if (editingNoteID === null) return;
    if (!confirm("Delete this note?")) return;
    notes = notes.filter(n => n.id !== editingNoteID);
    save("Notes", notes);
    closeModal('noteModal');
    renderNotes();
}

/* ===== CHECKLISTS ===== */
function openChecklists() {
    openToolPage("checklists");
    currentChecklistID = null;
    $("checklistDetailView").style.display = "none";
    $("checklistListView").style.display = "block";
    $("checklistsEditButton").style.display = "none";
    $("checklistsPageTitle").textContent = "Checklists";
    renderChecklistList();
}

function handleChecklistsBackClick() {
    if (currentChecklistID !== null) {
        currentChecklistID = null;
        $("checklistDetailView").style.display = "none";
        $("checklistListView").style.display = "block";
        $("checklistsEditButton").style.display = "none";
        $("checklistsPageTitle").textContent = "Checklists";
        renderChecklistList();
    } else {
        showToolsFromTool();
    }
}

function handleChecklistsAddClick() {
    if (currentChecklistID !== null) $("newChecklistItemText").focus();
    else openChecklistModal();
}

function renderChecklistList() {
    const container = $("checklistList");
    container.innerHTML = "";
    if (checklists.length === 0) {
        container.innerHTML = `<div class="profile-card static"><div style="font-size:40px;">☑️</div><div style="font-size:18px;font-weight:700;margin-top:10px;">No Checklists Yet</div><div style="color:var(--secondary);font-size:13px;margin-top:5px;">Create a checklist for packing, shopping, or anything else.</div></div>`;
        return;
    }
    checklists.forEach(c => {
        const done = c.items.filter(i => i.done).length;
        const card = document.createElement("div");
        card.className = "class-card";
        card.style.minHeight = "auto";
        card.onclick = () => openChecklistDetail(c.id);
        card.innerHTML = `
    <div style="display:flex;align-items:center;gap:9px;">
      <div style="width:12px;height:12px;border-radius:50%;background:${c.color};flex-shrink:0;"></div>
      <div class="class-name" style="padding-right:0;font-size:17px;">${escapeHTML(c.name)}</div>
    </div>
    <div class="class-code" style="margin-top:8px;">${done} of ${c.items.length} done</div>
  `;
        container.appendChild(card);
    });
}

function openChecklistDetail(id) {
    currentChecklistID = id;
    const c = checklists.find(cl => cl.id === id);
    if (!c) return;
    $("checklistListView").style.display = "none";
    $("checklistDetailView").style.display = "block";
    $("checklistsEditButton").style.display = "flex";
    $("checklistsPageTitle").textContent = c.name;
    renderChecklistItems();
}

function renderChecklistItems() {
    const c = checklists.find(cl => cl.id === currentChecklistID);
    const container = $("checklistItemsList");
    if (!c) { container.innerHTML = ""; return; }
    if (c.items.length === 0) {
        container.innerHTML = `<div class="profile-card static"><div style="font-size:36px;">✅</div><div style="font-size:15px;color:var(--secondary);margin-top:6px;">Add your first item above.</div></div>`;
        return;
    }
    container.innerHTML = c.items.map(i => `
  <div class="checklist-item">
    <button class="checklist-checkbox ${i.done ? "checked" : ""}" onclick="toggleChecklistItem(${i.id})">${i.done ? "✓" : ""}</button>
    <div class="checklist-item-text ${i.done ? "checked" : ""}" onclick="toggleChecklistItem(${i.id})">${escapeHTML(i.text)}</div>
    <button class="checklist-item-delete" onclick="deleteChecklistItem(${i.id})">×</button>
  </div>
`).join("");
}

function addChecklistItem() {
    const input = $("newChecklistItemText");
    const text = input.value.trim();
    if (!text) return;
    const c = checklists.find(cl => cl.id === currentChecklistID);
    if (!c) return;
    c.items.push({ id: Date.now(), text, done: false });
    save("Checklists", checklists);
    input.value = "";
    renderChecklistItems();
}

function toggleChecklistItem(itemID) {
    const c = checklists.find(cl => cl.id === currentChecklistID);
    if (!c) return;
    const item = c.items.find(i => i.id === itemID);
    if (!item) return;
    item.done = !item.done;
    save("Checklists", checklists);
    renderChecklistItems();
}

function deleteChecklistItem(itemID) {
    const c = checklists.find(cl => cl.id === currentChecklistID);
    if (!c) return;
    c.items = c.items.filter(i => i.id !== itemID);
    save("Checklists", checklists);
    renderChecklistItems();
}

function openChecklistModal(id = null) {
    editingChecklistID = id;
    if (id === null) {
        $("checklistModalTitle").textContent = "Add Checklist";
        $("editChecklistName").value = "";
        selectedChecklistColor = "#1769c2";
        $("deleteChecklistButton").style.display = "none";
    } else {
        const c = checklists.find(cl => cl.id === id);
        if (!c) return;
        $("checklistModalTitle").textContent = "Edit Checklist";
        $("editChecklistName").value = c.name;
        selectedChecklistColor = c.color;
        $("deleteChecklistButton").style.display = "block";
    }
    updateSelection("checklistColorOptions", ".color-option", "color", selectedChecklistColor);
    openModal("checklistModal");
}

function selectChecklistColor(el) { selectedChecklistColor = el.dataset.color; updateSelection("checklistColorOptions", ".color-option", "color", selectedChecklistColor); }

function saveChecklist() {
    const name = $("editChecklistName").value.trim();
    if (!name) { alert("Please enter a checklist name."); return; }
    if (editingChecklistID === null) {
        checklists.push({ id: Date.now(), name, color: selectedChecklistColor, items: [] });
    } else {
        const i = checklists.findIndex(c => c.id === editingChecklistID);
        if (i !== -1) { checklists[i].name = name; checklists[i].color = selectedChecklistColor; }
    }
    save("Checklists", checklists);
    closeModal('checklistModal');
    if (currentChecklistID !== null) {
        $("checklistsPageTitle").textContent = name;
        renderChecklistItems();
    } else {
        renderChecklistList();
    }
}

function deleteCurrentChecklist() {
    if (editingChecklistID === null) return;
    if (!confirm("Delete this checklist and all its items?")) return;
    checklists = checklists.filter(c => c.id !== editingChecklistID);
    save("Checklists", checklists);
    closeModal('checklistModal');
    currentChecklistID = null;
    $("checklistDetailView").style.display = "none";
    $("checklistListView").style.display = "block";
    $("checklistsEditButton").style.display = "none";
    $("checklistsPageTitle").textContent = "Checklists";
    renderChecklistList();
}

/* ===== RICH NOTES ===== */
let richNoteSaveTimer = null;

function openRichNotes() { openToolPage("richnotes"); renderRichNotesList(); }

function renderRichNotesList() {
    const container = $("richNotesList");
    container.innerHTML = "";
    if (richNotes.length === 0) {
        container.innerHTML = `<div class="profile-card static"><div style="font-size:36px;">📝</div><div style="font-size:16px;font-weight:700;margin-top:8px;">No Notes Yet</div><div style="color:var(--secondary);font-size:13px;margin-top:5px;">Create a note with formatting, images, and math.</div></div>`;
        return;
    }
    [...richNotes].sort((a, b) => (b.updated || 0) - (a.updated || 0)).forEach(n => {
        const snippet = (n.content || "").replace(/[#*_`>-]/g, "").replace(/!\[.*?\]\(.*?\)/g, "[image]").slice(0, 70);
        const btn = document.createElement("button");
        btn.className = "list-button";
        btn.onclick = () => openRichNoteEditor(n.id);
        btn.innerHTML = `
    <div class="list-icon">📝</div>
    <div class="list-info">
      <div class="list-title">${escapeHTML(n.title || "Untitled")}</div>
      <div class="list-subtitle">${escapeHTML(snippet)}${snippet.length >= 70 ? "…" : ""}</div>
    </div>
    <div class="arrow">›</div>
  `;
        container.appendChild(btn);
    });
}

function openRichNoteEditor(id = null) {
    editingRichNoteID = id;
    if (id === null) {
        $("richNoteTitle").value = "";
        $("richNoteContent").value = "";
        $("deleteRichNoteButton").style.display = "none";
    } else {
        const n = richNotes.find(note => note.id === id);
        if (!n) return;
        $("richNoteTitle").value = n.title;
        $("richNoteContent").value = n.content;
        $("deleteRichNoteButton").style.display = "block";
    }
    setRichNoteMode("edit");
    openToolPage("richNoteEditor");
}

function closeRichNoteEditor() {
    clearTimeout(richNoteSaveTimer);
    commitRichNote();
    openToolPage("richnotes");
    renderRichNotesList();
}

function commitRichNote() {
    const title = $("richNoteTitle").value.trim();
    const content = $("richNoteContent").value;
    if (!title && !content.trim()) {
        if (editingRichNoteID !== null) {
            richNotes = richNotes.filter(n => n.id !== editingRichNoteID);
            save("RichNotes", richNotes);
        }
        return;
    }
    if (editingRichNoteID === null) {
        editingRichNoteID = Date.now();
        richNotes.push({ id: editingRichNoteID, title, content, updated: Date.now() });
    } else {
        const i = richNotes.findIndex(n => n.id === editingRichNoteID);
        if (i !== -1) richNotes[i] = { ...richNotes[i], title, content, updated: Date.now() };
    }
    save("RichNotes", richNotes);
}

function onRichNoteChange() {
    clearTimeout(richNoteSaveTimer);
    richNoteSaveTimer = setTimeout(commitRichNote, 600);
}

function deleteCurrentRichNote() {
    if (editingRichNoteID === null) return;
    if (!confirm("Delete this note?")) return;
    richNotes = richNotes.filter(n => n.id !== editingRichNoteID);
    save("RichNotes", richNotes);
    editingRichNoteID = null;
    openToolPage("richnotes");
    renderRichNotesList();
}

function setRichNoteMode(mode) {
    const isEdit = mode === "edit";
    $("richNoteEditView").style.display = isEdit ? "block" : "none";
    $("richNotePreviewView").style.display = isEdit ? "none" : "block";
    $("richNoteEditModeBtn").classList.toggle("active", isEdit);
    $("richNotePreviewModeBtn").classList.toggle("active", !isEdit);
    if (!isEdit) renderRichNotePreview();
}

function renderRichNotePreview() {
    const raw = $("richNoteContent").value || "";
    const mathBlocks = [];
    let text = raw.replace(/\$\$([\s\S]+?)\$\$/g, (m, expr) => {
        mathBlocks.push({ expr, display: true });
        return `%%MATH${mathBlocks.length - 1}%%`;
    });
    text = text.replace(/\$([^$\n]+?)\$/g, (m, expr) => {
        mathBlocks.push({ expr, display: false });
        return `%%MATH${mathBlocks.length - 1}%%`;
    });
    let html = typeof marked !== "undefined" ? marked.parse(text) : escapeHTML(text);
    html = html.replace(/%%MATH(\d+)%%/g, (m, i) => {
        const { expr, display } = mathBlocks[i];
        try { return typeof katex !== "undefined" ? katex.renderToString(expr, { throwOnError: false, displayMode: display }) : m; }
        catch { return m; }
    });
    $("richNotePreviewView").innerHTML = html;
}

function richNoteWrap(before, after, placeholder) {
    const ta = $("richNoteContent");
    const start = ta.selectionStart, end = ta.selectionEnd;
    const text = ta.value;
    const selected = text.slice(start, end) || placeholder;
    ta.value = text.slice(0, start) + before + selected + after + text.slice(end);
    const pos = start + before.length + selected.length + after.length;
    ta.focus();
    ta.setSelectionRange(pos, pos);
    onRichNoteChange();
}

function richNotePrefixLine(prefix) {
    const ta = $("richNoteContent");
    const start = ta.selectionStart;
    const text = ta.value;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    ta.value = text.slice(0, lineStart) + prefix + text.slice(lineStart);
    const pos = start + prefix.length;
    ta.focus();
    ta.setSelectionRange(pos, pos);
    onRichNoteChange();
}

async function handleRichNoteImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    const dataUrl = await resizeImageFile(file, 900);
    const ta = $("richNoteContent");
    const start = ta.selectionStart;
    const md = `\n![](${dataUrl})\n`;
    ta.value = ta.value.slice(0, start) + md + ta.value.slice(start);
    ta.focus();
    ta.setSelectionRange(start + md.length, start + md.length);
    onRichNoteChange();
    event.target.value = "";
}

/* ===== PASSWORDS ===== */
let viewingPasswordID = null;
function openPasswordVault() { openToolPage("passwords"); renderPasswordEntries(); }

/* ===== STUDENTVUE ===== */
let svData = load("StudentVueData");
let svCalendarDate = new Date();
let svProfileDetails = null;
// Tracks whether a manual login has already succeeded once this page
// load (auto-login off case) — reset on every actual page reload, but
// not when just navigating back and forth between StudentVUE and its
// sub-pages (assignments, etc.) within the same visit.
let svUnlockedThisSession = false;

// Same dotted circular spinner used in the static #svLoadingView markup
// — kept as one constant here since the assignments page builds its
// loading state dynamically in JS.
const SV_SPINNER_HTML = `<div class="sv-spinner">
    <i style="transform:rotate(0deg) translateY(-17px);animation-delay:-1s;"></i>
    <i style="transform:rotate(45deg) translateY(-17px);animation-delay:-0.875s;"></i>
    <i style="transform:rotate(90deg) translateY(-17px);animation-delay:-0.75s;"></i>
    <i style="transform:rotate(135deg) translateY(-17px);animation-delay:-0.625s;"></i>
    <i style="transform:rotate(180deg) translateY(-17px);animation-delay:-0.5s;"></i>
    <i style="transform:rotate(225deg) translateY(-17px);animation-delay:-0.375s;"></i>
    <i style="transform:rotate(270deg) translateY(-17px);animation-delay:-0.25s;"></i>
    <i style="transform:rotate(315deg) translateY(-17px);animation-delay:-0.125s;"></i>
  </div>`;

function openStudentVue() {
    openToolPage("studentvue");
    const creds = load("StudentVueCreds");
    if (creds && creds.workerUrl && creds.portalUrl && creds.username && creds.password) {
        $("svWorkerUrl").value = creds.workerUrl;
        $("svPortalUrl").value = creds.portalUrl;
        $("svUsername").value = creds.username;
        $("svPassword").value = creds.password;
        if (svAutoLoginEnabled()) {
            $("svRefreshButton").style.display = "flex";
            if (svData && svData.courses) {
                renderStudentVue(svData);
            } else {
                // Nothing cached to show yet — a blank screen during the fetch
                // looked broken, so show a visible loading state instead.
                svShowLoading();
            }
            svFetchGrades(creds, { showLoginOnFail: true });
        } else if (svUnlockedThisSession && svData && svData.courses) {
            // Already logged in manually earlier this visit (e.g. came back
            // from Assignments via the back button) — no need to gate again.
            $("svRefreshButton").style.display = "flex";
            renderStudentVue(svData);
        } else {
            // Auto-login off means every visit requires an explicit tap —
            // cached data doesn't get a free pass, or the gate would only
            // ever show up on a totally empty cache (e.g. right after a
            // reload with data already saved from before, it would've
            // skipped straight past the gate).
            svShowLoginGate();
        }
    } else {
        svShowLoginView();
    }
}

function svShowLoading() {
    $("svLoginView").style.display = "none";
    $("svLoginGateView").style.display = "none";
    $("svDataView").style.display = "none";
    $("svLoadingView").style.display = "block";
}

function svShowLoginGate() {
    $("svLoginView").style.display = "none";
    $("svLoadingView").style.display = "none";
    $("svDataView").style.display = "none";
    $("svLoginGateView").style.display = "block";
    $("svRefreshButton").style.display = "none";
}

function svManualLogin() {
    const creds = load("StudentVueCreds");
    if (!creds) { svShowLoginView(); return; }
    $("svLoginGateView").style.display = "none";
    $("svRefreshButton").style.display = "flex";
    svShowLoading();
    svFetchGrades(creds, { showLoginOnFail: true });
}

function svShowLoginView() {
    $("svLoginGateView").style.display = "none";
    $("svLoadingView").style.display = "none";
    $("svLoginView").style.display = "block";
    $("svDataView").style.display = "none";
    $("svRefreshButton").style.display = "none";
}

function svSetError(msg) {
    const el = $("svLoginError");
    if (!msg) { el.style.display = "none"; el.textContent = ""; return; }
    el.textContent = msg;
    el.style.display = "block";
}

function svConnect() {
    const creds = {
        workerUrl: $("svWorkerUrl").value.trim().replace(/\/$/, ""),
        portalUrl: $("svPortalUrl").value.trim(),
        username: $("svUsername").value.trim(),
        password: $("svPassword").value,
    };
    if (!creds.workerUrl || !creds.portalUrl || !creds.username || !creds.password) {
        svSetError("Please fill in every field."); return;
    }
    const rememberMe = $("svRememberMe").checked;
    svSetError(null);
    $("svConnectButton").textContent = "Connecting…";
    $("svConnectButton").disabled = true;
    svFetchGrades(creds, {
        showLoginOnFail: false,
        // Unchecked: credentials stay in memory for this page load only —
        // nothing written to localStorage, so nothing goes to cloud sync
        // either. Next time the app opens, StudentVUE asks again.
        onSuccess: () => { if (rememberMe) save("StudentVueCreds", creds); },
        onDone: () => { $("svConnectButton").textContent = "Connect"; $("svConnectButton").disabled = false; }
    });
}

function svRefresh() {
    const creds = load("StudentVueCreds");
    if (creds) svFetchGrades(creds, { showLoginOnFail: false });
}

async function svFetchGrades(creds, opts = {}) {
    const refreshBtn = $("svRefreshButton");
    if (refreshBtn && refreshBtn.style.display !== "none") refreshBtn.classList.add("spinning");
    try {
        // One request, one login, one shared session server-side — the Worker
        // fetches gradebook/calendar/profile/schedule/course-history together
        // instead of the app firing five separate logins in parallel (which
        // could race each other on the district's server and intermittently
        // fail — see the "webAll" note in the Worker's own comments).
        let result = await svWorkerRequestRetrying(creds, "webAll");

        // Grades came back, but one or more of the other pieces (calendar,
        // profile, schedule, course history) didn't — that's usually a
        // one-off hiccup on a specific endpoint, not a real, lasting
        // problem, so take one more full pass and fill in whatever came
        // back this time rather than leaving those sections blank for the
        // rest of the session.
        if (Array.isArray(result.errors) && result.errors.length > 0) {
            try {
                const retryResult = await svWorkerRequestRetrying(creds, "webAll", {}, 2);
                const merged = { ...result };
                const fieldByLabel = {
                    webGradebook: "classes",
                    webCalendar: "calendar",
                    webProfile: "profile",
                    webSchedule: "schedule",
                    webCourseHistory: "courseHistory",
                    webStudentInfo: "studentInfo"
                };
                for (const key of ["classes", "calendar", "profile", "studentInfo", "schedule", "courseHistory"]) {
                    if ((merged[key] == null || (Array.isArray(merged[key]) && merged[key].length === 0)) && retryResult[key] != null) {
                        merged[key] = retryResult[key];
                    }
                }
                merged.errors = (retryResult.errors || []).filter(e => {
                    const label = e.split(":")[0]?.trim();
                    const field = fieldByLabel[label];
                    // Only still count it as an error if that field is genuinely
                    // still missing after both attempts.
                    return field && (merged[field] == null || (Array.isArray(merged[field]) && merged[field].length === 0));
                });
                result = merged;
            } catch {
                // The retry itself failing entirely just means we keep the
                // first attempt's (partial) result — better than nothing.
            }
        }

        const classes = (result.classes || []).map(c => {
            const periods = Array.isArray(c.gradingPeriods) ? c.gradingPeriods : [];
            const current = periods.length ? periods[periods.length - 1] : null;
            return {
                title: c.name || "Untitled",
                teacher: c.teacher || "",
                room: c.room || "",
                period: c.period || "",
                gradingPeriods: periods,
                scoreString: current?.mark || "—",
                scoreRaw: current?.score || "",
                percent: current?.score || "",
                classID: c.classID || "",
                focusArgs: c.focusArgs || null
            };
        });

        svData = {
            courses: classes,
            calendar: result.calendar || null,
            profile: result.profile || null,
            studentInfo: result.studentInfo || null,
            schedule: result.schedule || null,
            courseHistory: result.courseHistory || null,
            fetchedAt: Date.now(),
            errors: result.errors || [],
            rawJson: result
        };
        save("StudentVueData", svData);
        renderStudentVue(svData);
        svSetError(null);
        if (opts.onSuccess) opts.onSuccess();
    } catch (err) {
        console.error("[StudentVUE]", err);
        svSetError(err.message || "Couldn't connect to StudentVUE. Check your details and try again.");
        if (opts.showLoginOnFail) svShowLoginView();
    } finally {
        if (refreshBtn) refreshBtn.classList.remove("spinning");
        if (opts.onDone) opts.onDone();
    }
}

async function svWorkerRequest(creds, method, extra = {}) {
    const response = await fetch(creds.workerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, username: creds.username, password: creds.password, portalUrl: creds.portalUrl, ...extra })
    });
    let body;
    try { body = await response.json(); } catch { throw new Error(`Worker returned an invalid response for ${method}.`); }
    if (!response.ok || body.error) throw new Error(body.error || `StudentVUE request failed (${method}).`);
    return body;
}

// Wraps svWorkerRequest with a couple of retries + a short backoff.
// A lot of what's flowed through here is inherently a bit flaky — this
// is screen-scraping a live district server, not a stable published
// API — so a single transient hiccup (a slow response, a session race,
// a one-off 500) shouldn't surface as a hard failure to the person
// using the app when trying again a moment later would've just worked.
// Errors that clearly won't change on retry (bad credentials, a
// malformed request) still fail immediately instead of wasting time.
async function svWorkerRequestRetrying(creds, method, extra = {}, attempts = 3) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await svWorkerRequest(creds, method, extra);
        } catch (err) {
            lastErr = err;
            const msg = err.message || "";
            if (/username and password|missing one of|invalid json|missing ".*"|couldn't understand that portal url/i.test(msg)) {
                throw err;
            }
            if (i < attempts - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
        }
    }
    throw lastErr;
}

function svNormalizeDate(value) {
    if (!value) return null;
    const str = String(value).trim();

    // ISO / PXP2 formats such as 2026-08-18 or 20260818.
    let match = str.match(/(\d{4})[-\/]?(\d{2})[-\/]?(\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;

    // Common StudentVUE formats such as 08/18/2026 or 8/18/2026.
    match = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (match) return `${match[3]}-${String(match[1]).padStart(2, "0")}-${String(match[2]).padStart(2, "0")}`;

    // Fall back to the browser's date parser for values containing a time.
    const parsed = new Date(str);
    if (!Number.isNaN(parsed.getTime())) {
        return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
    }
    return null;
}

function svFormatTime(value) {
    if (!value) return "";
    const str = String(value).trim();
    const d = new Date(`1970-01-01T${str}`);
    if (!Number.isNaN(d.getTime()) && /\d/.test(str)) {
        return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    return str;
}

// Reads the first present key from an object, tolerant of different casing
// / naming conventions a Worker's JSON might use for the same field.
function svField(obj, ...keys) {
    if (!obj) return null;
    for (const k of keys) {
        if (obj[k] != null && obj[k] !== "") return obj[k];
    }
    return null;
}

// Schedule responses can come back shaped a few different ways depending on
// how the Worker built them — try the common shapes rather than assume one.
function svExtractScheduleEntries(scheduleResponse) {
    if (!scheduleResponse) return [];
    const schools = svField(scheduleResponse, "schools", "Schools") || svField(scheduleResponse.schedule || {}, "schools", "Schools");
    if (Array.isArray(schools)) {
        const flat = schools.flatMap(s => svField(s, "classes", "Classes") || []);
        if (flat.length) return flat;
    }
    const direct = svField(scheduleResponse, "classes", "Classes") || svField(scheduleResponse.schedule || {}, "classes", "Classes");
    if (Array.isArray(direct) && direct.length) return direct;
    return [];
}

function svGetClassTime(course) {
    const entries = svExtractScheduleEntries(svData?.schedule);
    if (!entries.length) return "";
    const coursePeriodDigits = course.period != null ? String(course.period).replace(/\D/g, "") : "";
    const coursePeriodNum = coursePeriodDigits ? parseInt(coursePeriodDigits, 10) : NaN;
    const courseTitle = (course.title || "").toLowerCase().trim();

    let match = null;
    if (!Number.isNaN(coursePeriodNum)) {
        match = entries.find(c => {
            const p = svField(c, "period", "Period", "periodName", "PeriodName");
            if (p == null) return false;
            const pNum = parseInt(String(p).replace(/\D/g, ""), 10);
            return !Number.isNaN(pNum) && pNum === coursePeriodNum;
        });
    }
    if (!match && courseTitle) {
        match = entries.find(c => {
            const name = (svField(c, "className", "CourseName", "courseName", "name", "Name", "title", "Title") || "").toLowerCase();
            // Schedule class names often include a course code and section number
            // around the title (e.g. "12600 Environmental Science - 12600-00002"),
            // so a substring match works better here than an exact match.
            return name && (name.includes(courseTitle) || courseTitle.includes(name));
        });
    }
    if (!match) return "";
    const start = svFormatTime(svField(match, "startTime", "StartTime", "start", "Start"));
    const end = svFormatTime(svField(match, "endTime", "EndTime", "end", "End"));
    return start && end ? `${start} – ${end}` : start || end || "";
}

function svGetRankSummary() {
    const summaries = svData?.courseHistory?.gpa || [];
    if (!summaries.length) return null;
    return summaries.find(x => x && x.classRank != null) || summaries.find(x => x && x.gpa != null) || summaries[0];
}

function renderStudentVue(data) {
    svUnlockedThisSession = true;
    $("svLoginView").style.display = "none";
    $("svLoginGateView").style.display = "none";
    $("svLoadingView").style.display = "none";
    $("svDataView").style.display = "block";
    $("svRefreshButton").style.display = "flex";
    const lastUpdated = $("svLastUpdated");
    if (lastUpdated) {
        lastUpdated.textContent = data.fetchedAt
            ? "Updated " + new Date(data.fetchedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
            : "";
    }

    // webProfile returns the profile object directly. Keep this tolerant of
    // cached/older response shapes, and of different key names the Worker's
    // JSON might use for the same fields, since photo/name/school naming
    // varies a lot between StudentVUE implementations.
    const profileResponse = data.profile || {};
    const profile = profileResponse.profile || profileResponse.student || profileResponse;
    const studentInfo = data.studentInfo || {};
    // Student Information (PXP2_Student.aspx) has the cleanest full name
    // (first + middle initial + last) and the ID/gender/grade fields;
    // fall back to whatever the landing-page profile has if that page
    // couldn't be reached.
    const profileFullName = svField(studentInfo, "name") || svField(profile, "name", "Name", "studentName", "StudentName", "fullName", "FullName") || "Student";
    const profileFirst = svField(studentInfo, "firstName");
    const profileLast = svField(studentInfo, "lastName");
    // Card shows just first + last; falls back to the full name if the
    // Worker couldn't split it (e.g. webStudentInfo failed).
    const profileShortName = (profileFirst && profileLast) ? `${profileFirst} ${profileLast}` : profileFullName;
    const profileSchool = svField(profile, "school", "School", "schoolName", "SchoolName", "currentSchool", "CurrentSchool") || "StudentVUE";
    const profileId = svField(studentInfo, "permID") || svField(profile, "sisNumber", "SisNumber", "studentID", "StudentID", "studentId", "permID", "PermID");
    const profileGender = svField(studentInfo, "gender");
    const profileGrade = svField(studentInfo, "grade");
    const profileUserId = svField(studentInfo, "userID", "UserID", "userId");
    const profileHomeAddress = svField(studentInfo, "homeAddress", "HomeAddress");
    const profilePhoneNumbers = Array.isArray(studentInfo.phoneNumbers) ? studentInfo.phoneNumbers : [];
    // p.number can come through as "xxx-xxx-xxxx (not listed)" — strip
    // everything but the digits and reformat as (XXX) XXX-XXXX, so the
    // type label, "(not listed)" note, and "(primary)" marker all drop
    // out; a number that isn't a clean 10 digits falls back to showing
    // whatever was there rather than guessing at its shape.
    const formatPhoneNumber = (raw) => {
        if (!raw) return null;
        const digits = String(raw).replace(/\D/g, "");
        const tenDigits = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
        if (tenDigits.length === 10) return `(${tenDigits.slice(0, 3)}) ${tenDigits.slice(3, 6)}-${tenDigits.slice(6)}`;
        return String(raw).trim();
    };
    const profilePhoneText = profilePhoneNumbers.length
        ? profilePhoneNumbers.map(p => formatPhoneNumber(p.number)).filter(Boolean).join("\n")
        : null;
    let profilePhoto = svField(profile, "photoDataUri", "photo", "Photo", "photoUrl", "PhotoUrl", "pictureUrl", "PictureUrl", "image", "Image", "imageData", "ImageData", "base64Photo", "PhotoData", "studentPhoto", "StudentPhoto");
    if (profilePhoto && typeof profilePhoto === "string" && !profilePhoto.startsWith("data:") && !profilePhoto.startsWith("http")) {
        profilePhoto = `data:image/jpeg;base64,${profilePhoto}`;
    }
    // Kept around so openSvProfileModal() can populate the detail modal
    // without recomputing all of this from data.rawJson.
    svProfileDetails = { fullName: profileFullName, school: profileSchool, id: profileId, gender: profileGender, grade: profileGrade, userId: profileUserId, homeAddress: profileHomeAddress, phone: profilePhoneText };
    const initials = profileShortName.split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0]).join("").toUpperCase() || "S";
    const profileCard = $("svProfileCard");
    if (profileCard) {
        profileCard.innerHTML = profilePhoto
            ? `<img class="sv-profile-photo" src="${profilePhoto}" alt="Student profile picture" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"><div class="sv-profile-placeholder" style="display:none;">${escapeHTML(initials)}</div>`
            : `<div class="sv-profile-placeholder">${escapeHTML(initials)}</div>`;
        profileCard.innerHTML += `<div style="flex:1;min-width:0;"><div class="sv-profile-name">${escapeHTML(profileShortName)}</div><div class="sv-profile-school">${escapeHTML(profileSchool)}</div>${profileId ? `<div class="sv-profile-school">ID: ${escapeHTML(String(profileId))}</div>` : ""}</div><div class="arrow">›</div>`;
    }

    const courseHistory = data.courseHistory || {};
    const summary = svGetRankSummary();
    const summaries = Array.isArray(courseHistory.gpa) ? courseHistory.gpa : [];
    const gpaEl = $("svGpaValue");
    const gpaLabelEl = $("svGpaLabel");
    const rankEl = $("svRankValue");
    const rankLabelEl = $("svRankLabel");
    if (gpaEl) gpaEl.textContent = summary?.gpa != null ? Number(summary.gpa).toFixed(2) : "—";
    if (gpaLabelEl) gpaLabelEl.textContent = summaries.length ? (summaries.find(x => x.label === "HS Cumulative GPA")?.label || summary?.label || "StudentVUE") : "StudentVUE";
    if (rankEl) rankEl.textContent = summary?.classRank != null && summary?.classSize != null ? `${summary.classRank} / ${summary.classSize}` : "—";
    if (rankLabelEl) rankLabelEl.textContent = summary?.classRank != null ? "Class rank" : "StudentVUE";

    const errorBanner = $("svErrorBanner");
    if (errorBanner) {
        const friendlyNames = { webCalendar: "Calendar", webProfile: "Profile", webSchedule: "Schedule", webCourseHistory: "Course History", webStudentInfo: "Student Info", webGradebook: "Classes" };
        const failed = (data.errors || []).map(e => e.split(":")[0]).map(m => friendlyNames[m] || m);
        if (failed.length) {
            errorBanner.style.display = "block";
            errorBanner.textContent = `Couldn't load: ${failed.join(", ")}. Tap ↻ to try those again.`;
        } else {
            errorBanner.style.display = "none";
        }
    }

    renderSvCalendar();

    const container = $("svClassList");
    container.innerHTML = "";
    $("svRawResponse").style.display = "none";
    $("svRawResponse").textContent = data.rawJson ? JSON.stringify(data.rawJson, null, 2) : "";
    const rawToggleBtn = $("svRawToggleButton");
    if (rawToggleBtn) rawToggleBtn.textContent = "Show Raw Response";

    if (!data.courses || data.courses.length === 0) {
        container.innerHTML = `<div class="profile-card static"><div style="font-size:40px;">🎓</div><div style="font-size:18px;font-weight:700;margin-top:10px;">No Classes Found</div><div style="color:var(--secondary);font-size:13px;margin-top:5px;">StudentVUE didn't return any classes.</div></div>`;
    } else {
        svSortedCourses(data.courses).forEach(c => {
            const card = document.createElement("div");
            card.className = "class-card";
            card.style.cursor = c.focusArgs ? "pointer" : "default";
            const time = svGetClassTime(c);
            const percent = c.percent ? String(c.percent) : "";
            card.innerHTML = `
          <div class="class-name">${escapeHTML(c.title)}</div>
          <div class="class-code">${escapeHTML(c.teacher)}</div>
          <div class="sv-card-top-right">
            <div class="sv-class-grade">${escapeHTML(c.scoreString || "—")}</div>
            ${percent ? `<div class="sv-class-percent">${escapeHTML(percent)}</div>` : ""}
          </div>
          <div class="sv-card-bottom-left">
            ${time ? `<div class="sv-class-time">${escapeHTML(time)}</div>` : ""}
          </div>
          <div class="sv-card-bottom-right">
            ${c.room ? `<div class="sv-card-room">${escapeHTML(c.room)}</div>` : ""}
          </div>
        `;
            if (c.focusArgs) card.addEventListener("click", () => openSvAssignments(c));
            container.appendChild(card);
        });
    }
}

// Orders classes the way they run through the day: by period number when
// the Worker gave us one, falling back to the class's scheduled start
// time (from the Schedule page) for anything without a usable period —
// more reliable than trusting whatever order Gradebook.aspx happened to
// list classes in, which doesn't always match period order.
function svSortedCourses(courses) {
    const withKey = courses.map((c, idx) => {
        const digits = c.period != null ? String(c.period).replace(/\D/g, "") : "";
        let key = digits ? parseInt(digits, 10) : null;
        if (key == null) {
            const time = svGetClassTime(c);
            const startStr = time ? time.split("–")[0].trim() : "";
            const parsed = startStr ? new Date(`1970-01-01 ${startStr}`) : null;
            key = parsed && !Number.isNaN(parsed.getTime()) ? parsed.getTime() : Infinity;
        }
        return { c, key, idx };
    });
    withKey.sort((a, b) => (a.key - b.key) || (a.idx - b.idx));
    return withKey.map(x => x.c);
}

let svAssignmentsCurrentCourse = null;
let svAssignmentsGradeData = null;

async function reloadSvAssignments() {
    if (!svAssignmentsCurrentCourse) return;
    await openSvAssignments(svAssignmentsCurrentCourse);
}

async function openSvAssignments(course) {
    if (!course.focusArgs) return;
    svAssignmentsCurrentCourse = course;
    const creds = load("StudentVueCreds");
    if (!creds) return;

    const content = $("svAssignmentsPageContent");
    const refreshBtn = $("svAssignmentsRefreshButton");
    if (refreshBtn) refreshBtn.classList.add("spinning");
    openToolPage("svAssignmentsPage");
    content.innerHTML = `<div class="calendar-empty">${SV_SPINNER_HTML}Loading assignments…</div>`;

    const grade = course.scoreString || "—";
    const percent = course.percent ? String(course.percent) : "—";
    const period = course.period || "—";
    const room = course.room || "—";
    const teacher = course.teacher || "—";

    const classInfo = `
      <div class="sv-assignment-class-info">
        <div class="sv-assignment-class-title">${escapeHTML(course.title || "Class")}</div>
        <div class="sv-assignment-class-teacher">${escapeHTML(teacher)}</div>
        <div class="sv-assignment-class-stats">
          <div class="sv-assignment-class-stat"><div class="sv-assignment-class-stat-label">Grade</div><div class="sv-assignment-class-stat-value">${escapeHTML(grade)}</div></div>
          <div class="sv-assignment-class-stat"><div class="sv-assignment-class-stat-label">Percent</div><div class="sv-assignment-class-stat-value">${escapeHTML(percent)}</div></div>
          <div class="sv-assignment-class-stat"><div class="sv-assignment-class-stat-label">Period</div><div class="sv-assignment-class-stat-value">${escapeHTML(period)}</div></div>
          <div class="sv-assignment-class-stat"><div class="sv-assignment-class-stat-label">Room</div><div class="sv-assignment-class-stat-value">${escapeHTML(room)}</div></div>
        </div>
      </div>`;
    content.innerHTML = classInfo + `<div class="calendar-empty">${SV_SPINNER_HTML}Loading assignments…</div>`;

    try {
        const result = await svWorkerRequestRetrying(creds, "webAssignments", { focusArgs: course.focusArgs });
        svAssignmentsGradeData = result;
        renderSvAssignments(result.weeks || [], classInfo);
    } catch (err) {
        console.error("[StudentVUE]", err);
        content.innerHTML = classInfo + `<div class="calendar-empty"><div class="calendar-empty-icon">⚠️</div>${escapeHTML(err.message || "Couldn't load assignments.")}</div>`;
    } finally {
        if (refreshBtn) refreshBtn.classList.remove("spinning");
    }
}

function svAssignmentDateParts(value) {
    if (!value) return { month: "", day: "" };
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return { month: "", day: "" };
    return {
        month: d.toLocaleDateString("en-US", { month: "short" }).toUpperCase(),
        day: d.toLocaleDateString("en-US", { day: "2-digit" })
    };
}

const svAssignmentSimulations = new Map();
let svCurrentAssignmentWeeks = [];

function svNum(value) {
    const n = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : null;
}

function svFindMeasure(item, measures) {
    const id = svField(item, "measureId", "MeasureID", "measureTypeId", "MeasureTypeID", "measureTypeGU", "MeasureTypeGU");
    const name = svField(item, "measureName", "MeasureName", "measureTypeName", "MeasureTypeName", "assignmentType");

    if (id != null) {
        const byId = measures.find(m => String(m.id) === String(id));
        if (byId) return byId;
    }

    if (name) {
        const lower = String(name).toLowerCase();
        const byName = measures.find(m => String(m.name || "").toLowerCase() === lower);
        if (byName) return byName;
        const partial = measures.find(m => {
            const mn = String(m.name || "").toLowerCase();
            return mn && (mn.includes(lower) || lower.includes(mn));
        });
        if (partial) return partial;
    }

    return null;
}

function svGetWeightedMeasures() {
    const measures = Array.isArray(svAssignmentsGradeData?.measureTypes)
        ? svAssignmentsGradeData.measureTypes
        : [];
    return measures.filter(m => Number(m.weight) > 0);
}

function svGetAssignmentKey(item, weekIndex, itemIndex) {
    const title = item?.title || "Untitled";
    const due = item?.dueDate || "";
    return `${weekIndex}:${itemIndex}:${title}:${due}`;
}

function svGetOriginalAssignmentScore(item) {
    const possible = svNum(
        item?.pointsPossible ??
        item?.PointsPossible ??
        item?.points_possible ??
        item?.Points_Possible
    );

    if (possible == null || possible <= 0) return null;

    // If StudentVUE explicitly says there is no grade, keep the assignment N/A.
    if (
        item?.hasGrade === false ||
        item?.showAssignmentGrade === false ||
        item?.ShowAssignmentGrade === false
    ) {
        return null;
    }

    // gradeMark is the authoritative earned-score field.
    // Do NOT clamp it to pointsPossible because extra credit is valid.
    const mark = String(
        item?.gradeMark ??
        item?.GradeMark ??
        item?.mark ??
        item?.Mark ??
        ""
    ).trim();

    // Also support values such as "8/6".
    const fraction = mark.match(
        /^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/
    );

    if (fraction) {
        const earned = Number(fraction[1]);
        if (Number.isFinite(earned) && earned >= 0) {
            return earned;
        }
    }

    // StudentVUE's gradeMark is normally the earned-point value.
    const numericMark = svNum(mark);
    if (numericMark != null && numericMark >= 0) {
        return numericMark;
    }

    // Fallback to explicit earned-point fields.
    const explicit = svNum(
        item?.earnedPoints ??
        item?.pointsEarned ??
        item?.PointsEarned ??
        item?.earned ??
        item?.Earned
    );

    if (explicit != null && explicit >= 0) {
        return explicit;
    }

    // Last fallback: percentage, only for an assignment StudentVUE says is graded.
    const pct = svNum(
        item?.percent ??
        item?.calcValue ??
        item?.CalcValue ??
        item?.percentage ??
        item?.Percentage
    );

    if (pct != null && pct >= 0 && item?.hasGrade !== false) {
        return possible * pct / 100;
    }

    return null;
}

function svGetAllAssignments() {
    const out = [];
    svCurrentAssignmentWeeks.forEach((week, wi) => {
        (week.items || []).forEach((item, ii) => {
            const possible = svNum(item.pointsPossible);
            if (possible == null || possible <= 0) return;
            const measure = svFindMeasure(item, svAssignmentsGradeData?.measureTypes || []);
            out.push({
                key: svGetAssignmentKey(item, wi, ii),
                item,
                possible,
                earned: svGetOriginalAssignmentScore(item),
                measure,
                comment: item.comment || "",
            });
        });
    });
    return out;
}

function svGradeFromPercentage(pct) {
    if (pct == null || !Number.isFinite(pct)) return "—";

    // StudentVUE's class-data score ranges are the authoritative scale when available.
    const scales = svAssignmentsGradeData?.scoreScales || [];
    for (const s of scales) {
        const low = svNum(s.lowScore);
        const high = svNum(s.highScore);
        if (low != null && high != null && pct >= low && pct <= high) {
            return String(s.score ?? "—");
        }
    }

    // Safe fallback for districts where score ranges weren't exposed.
    if (pct >= 90) return "A";
    if (pct >= 80) return "B";
    if (pct >= 70) return "C";
    if (pct >= 60) return "D";
    return "F";
}

function svCalculateSimulatedGrade() {
    const basePct = svNum(svAssignmentsGradeData?.percentage);

    // Nothing touched yet — show the real percentage exactly, rather than
    // a from-scratch recomputation that can drift from it (a small-point
    // extra-credit assignment sitting well above 100% is exactly the kind
    // of outlier that exposes any gap between our weighting approximation
    // and whatever exact method the district's gradebook uses internally).
    if (svAssignmentSimulations.size === 0) {
        return { pct: basePct, mark: svGradeFromPercentage(basePct), supported: basePct != null };
    }

    const measures = svGetWeightedMeasures();
    const assignments = svGetAllAssignments();

    if (!assignments.length) {
        return { pct: basePct, mark: svGradeFromPercentage(basePct), supported: false };
    }

    // If StudentVUE exposes weighted categories but assignments don't expose
    // category IDs, don't silently invent category membership.
    const hasAnyMeasure = assignments.some(a => a.measure);
    if (!measures.length || !hasAnyMeasure || basePct == null) {
        return { pct: basePct, mark: svGradeFromPercentage(basePct), supported: false };
    }

    // For each weighted category, compare its ORIGINAL (unmodified) totals
    // against its SIMULATED (slider-adjusted) totals. The category's
    // percentage SHIFT — not its absolute percentage — is what gets
    // blended into the real baseline. This keeps the simulator anchored to
    // the true percentage and only ever asks "how much does this specific
    // edit move the needle," which sidesteps needing to perfectly
    // reproduce StudentVUE's own aggregate formula.
    const categoryCurrent = new Map();
    const categorySimulated = new Map();

    for (const a of assignments) {
        if (!a.measure || Number(a.measure.weight) <= 0) continue;
        const key = String(a.measure.id ?? a.measure.name);

        if (!categoryCurrent.has(key)) categoryCurrent.set(key, { measure: a.measure, earned: 0, possible: 0 });
        if (!categorySimulated.has(key)) categorySimulated.set(key, { measure: a.measure, earned: 0, possible: 0 });

        if (a.earned != null) {
            const cur = categoryCurrent.get(key);
            cur.earned += a.earned;
            cur.possible += a.possible;
        }

        const simulation = svAssignmentSimulations.get(a.key);
        const score = simulation != null ? simulation : a.earned;
        if (score != null) {
            const sim = categorySimulated.get(key);
            sim.earned += score;
            sim.possible += a.possible;
        }
    }

    let weightedDelta = 0;
    let weightTotal = 0;

    for (const [key, simStat] of categorySimulated) {
        if (simStat.possible <= 0) continue;
        const weight = Number(simStat.measure.weight) || 0;
        if (weight <= 0) continue;

        const curStat = categoryCurrent.get(key);
        const simPct = simStat.earned / simStat.possible * 100;
        // A category with no original graded work has no baseline to diff
        // against — treat its simulated percentage as the delta's target
        // directly rather than dividing by zero.
        const curPct = curStat && curStat.possible > 0 ? curStat.earned / curStat.possible * 100 : simPct;

        weightedDelta += (simPct - curPct) * weight;
        weightTotal += weight;
    }

    if (weightTotal <= 0) {
        return { pct: basePct, mark: svGradeFromPercentage(basePct), supported: false };
    }

    const pct = basePct + weightedDelta / weightTotal;
    return { pct, mark: svGradeFromPercentage(pct), supported: true };
}

function svUpdateAllSimulators() {
    document.querySelectorAll(".sv-assignment-simulator").forEach(el => {
        const result = svCalculateSimulatedGrade();
        const pctEl = el.querySelector(".sv-sim-class-percent");
        const markEl = el.querySelector(".sv-sim-class-mark");

        if (pctEl) {
            const decimalMode = pctEl.dataset.decimalMode === "true";
            pctEl.textContent =
                result.pct == null
                    ? "—"
                    : decimalMode
                        ? `${result.pct.toFixed(2)}%`
                        : `${Math.floor(result.pct)}%`;
        }

        if (markEl) markEl.textContent = result.mark || "—";

        const note = el.querySelector(".sv-sim-note");
        if (note) {
            note.textContent = result.supported
                ? ""
                : "StudentVUE did not provide enough category/assignment data to calculate a weighted projection, so the current class grade is shown.";
        }
    });
}

function svToggleAssignmentSimulator(key, button) {
    const simulator = document.querySelector(`[data-sim-key="${CSS.escape(key)}"]`);

    if (simulator) {
        simulator.remove();
        svAssignmentSimulations.delete(key);
        if (button) button.setAttribute("aria-expanded", "false");
        svUpdateAllSimulators();
        return;
    }

    const row = document.querySelector(`[data-assignment-key="${CSS.escape(key)}"]`);
    if (!row) return;

    const assignment = svGetAllAssignments().find(a => a.key === key);
    if (!assignment) return;

    const hasCurrentScore = assignment.earned != null;

    // If the assignment already has a score, the simulator starts at that
    // exact score. If it does not, leave it as N/A until the user actually
    // moves the slider.
    // Start at the actual StudentVUE gradeMark.
    // Extra credit is allowed, so the slider may extend past pointsPossible.
    const initial = hasCurrentScore
        ? Math.max(0, Math.round(assignment.earned))
        : 0;

    const sliderMax = hasCurrentScore
        ? Math.max(assignment.possible, initial)
        : assignment.possible;

    // IMPORTANT:
    // Do NOT put an unscored assignment into the simulation map yet.
    // That keeps the current class grade/percentage as the default.
    if (hasCurrentScore) {
        svAssignmentSimulations.set(key, initial);
    } else {
        svAssignmentSimulations.delete(key);
    }

    const wrapper = document.createElement("div");
    wrapper.className = "sv-assignment-simulator";
    wrapper.dataset.simKey = key;

    const result = svCalculateSimulatedGrade();

    const measureName = assignment.measure?.name || "Not available";
    const measureWeight = Number(assignment.measure?.weight);

    const weightText = Number.isFinite(measureWeight) && measureWeight > 0
        ? `${measureWeight.toFixed(2).replace(/\.00$/, "")}%`
        : "N/A";

    const scoreText = hasCurrentScore
        ? `${initial} / ${assignment.possible}`
        : `— / ${assignment.possible}`;

    wrapper.innerHTML = `
      <div class="sv-sim-score-line">
        <span>If you score</span>
        <strong class="sv-sim-assignment-score">${scoreText}</strong>
      </div>

      <input
        class="sv-sim-range"
        type="range"
        min="0"
        max="${sliderMax}"
        step="1"
        value="${initial}"
      >

      <div class="sv-sim-scale">
        <span>0</span>
        <span>${sliderMax}</span>
      </div>

      <div class="sv-sim-results">
        <div class="sv-sim-result sv-sim-class-toggle" role="button" tabindex="0">
          <div class="sv-sim-result-label">Class Grade Would Be</div>
          <div class="sv-sim-result-value sv-sim-class-mark">${escapeHTML(result.mark || "—")}</div>
        </div>
        <div class="sv-sim-result sv-sim-percent-toggle" role="button" tabindex="0">
          <div class="sv-sim-result-label">Percentage Would Be</div>
          <div class="sv-sim-result-value sv-sim-class-percent">${result.pct == null ? "—" : Math.floor(result.pct) + "%"}</div>
        </div>
      </div>

      <div class="sv-sim-info" style="display:none;">
        <div class="sv-sim-category">
          <span class="sv-sim-info-label">Category</span>
          <strong>${escapeHTML(measureName)}</strong>
        </div>
        <div class="sv-sim-category">
          <span class="sv-sim-info-label">Category Weight</span>
          <strong>${escapeHTML(weightText)}</strong>
        </div>
      </div>

      <button type="button" class="sv-sim-reset">Reset</button>
      <div class="sv-sim-note"></div>
    `;

    row.insertAdjacentElement("afterend", wrapper);

    const range = wrapper.querySelector(".sv-sim-range");
    const scoreEl = wrapper.querySelector(".sv-sim-assignment-score");
    const percentEl = wrapper.querySelector(".sv-sim-class-percent");
    const percentToggle = wrapper.querySelector(".sv-sim-percent-toggle");

    const updateRangeFill = () => {
        const min = Number(range.min) || 0;
        const max = Number(range.max) || 100;
        const val = Number(range.value);
        const pct = max > min ? Math.min(100, Math.max(0, ((val - min) / (max - min)) * 100)) : 0;
        range.style.setProperty("--sv-range-fill", pct + "%");
    };
    updateRangeFill();


    let showDecimalPercent = false;

    const renderPercent = (pct) => {
        if (pct == null) {
            percentEl.textContent = "—";
            return;
        }

        percentEl.dataset.decimalMode = showDecimalPercent ? "true" : "false";
        percentEl.textContent = showDecimalPercent
            ? pct.toFixed(2) + "%"
            : Math.floor(pct) + "%";
    };

    const togglePercent = () => {
        showDecimalPercent = !showDecimalPercent;
        percentEl.dataset.decimalMode = showDecimalPercent ? "true" : "false";

        const current = svCalculateSimulatedGrade();
        renderPercent(current.pct);
    };

    // Whole-number percentage is always the default for a newly opened simulator.
    percentEl.dataset.decimalMode = "false";

    percentToggle.addEventListener("click", (event) => {
        event.stopPropagation();
        togglePercent();
    });

    percentToggle.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            togglePercent();
        }
    });

    const classGradeToggle = wrapper.querySelector(".sv-sim-class-toggle");
    const infoBlock = wrapper.querySelector(".sv-sim-info");

    const toggleInfoBlock = () => {
        infoBlock.style.display = infoBlock.style.display === "none" ? "grid" : "none";
    };

    classGradeToggle.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleInfoBlock();
    });

    classGradeToggle.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            toggleInfoBlock();
        }
    });

    range.addEventListener("input", () => {
        const value = Number(range.value);

        // The moment the slider is moved, this assignment becomes a
        // simulation even if it originally had no score.
        svAssignmentSimulations.set(key, value);

        scoreEl.textContent = `${value} / ${assignment.possible}`;
        updateRangeFill();

        svUpdateAllSimulators();
    });

    wrapper.querySelector(".sv-sim-reset").addEventListener("click", (e) => {
        e.stopPropagation();
        svAssignmentSimulations.delete(key);
        wrapper.remove();

        if (button) {
            button.setAttribute("aria-expanded", "false");
        }

        svUpdateAllSimulators();
    });

    button?.setAttribute("aria-expanded", "true");
    svUpdateAllSimulators();
}

function renderSvAssignments(weeks, classInfo = "") {
    const content = $("svAssignmentsPageContent");
    const hasItems = weeks.some(w => Array.isArray(w.items) && w.items.length);
    svCurrentAssignmentWeeks = weeks || [];
    svAssignmentSimulations.clear();

    if (!hasItems) {
        content.innerHTML = classInfo + `<div class="calendar-empty sv-assignment-empty"><div class="calendar-empty-icon">📄</div>No assignments found for this class.</div>`;
        return;
    }

    content.innerHTML = classInfo + `<div class="sv-assignment-list">${weeks.map((w, wi) => {
        const items = Array.isArray(w.items) ? w.items : [];
        if (!items.length) return "";
        return `
        <section class="sv-assignment-week">
          <div class="sv-assignment-week-header">
            ${escapeHTML(w.week || "Week")} <span>(${items.length} ${items.length === 1 ? "item" : "items"})</span>
          </div>
          <div class="sv-assignment-items">
            ${items.map((i, ii) => {
            const graded = i.itemType === "GradeBookItem";
            const date = svAssignmentDateParts(i.dueDate);
            const metaParts = [i.assignmentType || (graded ? "Assignment" : "Resource")];
            if (i.pointsPossible) metaParts.push(`${i.pointsPossible} points`);
            const key = svGetAssignmentKey(i, wi, ii);
            const clickable = graded && svNum(i.pointsPossible) > 0;

            return `
                <div class="sv-assignment-row ${clickable ? "sv-sim-clickable" : ""}"
                     ${clickable ? `data-assignment-key="${escapeHTML(key)}" role="button" tabindex="0" aria-expanded="false"` : ""}>
                  <div class="sv-assignment-date">
                    ${date.month ? `<div class="sv-assignment-month">${escapeHTML(date.month)}</div><div class="sv-assignment-day">${escapeHTML(date.day)}</div>` : `<div class="sv-assignment-day">—</div>`}
                  </div>
                  <div class="sv-assignment-main">
                    <div class="sv-assignment-title">${escapeHTML(i.title || "Untitled")}</div>
                    <div class="sv-assignment-meta">${escapeHTML(metaParts.join(" | "))}</div>
                    </div>
                    ${graded ? `
                    <div class="sv-assignment-result">
                      <div class="sv-assignment-score">${i.hasGrade && i.gradeMark ? escapeHTML(String(i.gradeMark)) : "—"}</div>
                      ${i.comment && String(i.comment).trim() !== "" ? `<div class="sv-assignment-comment">${escapeHTML(String(i.comment))}</div>` : ""}
                      ${i.percent ? `<div class="sv-assignment-percent">${escapeHTML(String(i.percent))}</div>` : ""}
                    </div>` : `<div class="sv-assignment-result"></div>`}
                </div>`;
        }).join("")}
          </div>
        </section>`;
    }).join("")}</div>`;

    content.querySelectorAll(".sv-sim-clickable").forEach(row => {
        const key = row.dataset.assignmentKey;
        const toggle = () => svToggleAssignmentSimulator(key, row);
        row.addEventListener("click", toggle);
        row.addEventListener("keydown", e => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggle();
            }
        });
    });
}

let svCalendarEventMap = {};

function svCalendarPrev() { svCalendarDate = new Date(svCalendarDate.getFullYear(), svCalendarDate.getMonth() - 1, 1); renderSvCalendar(); }
function svCalendarNext() { svCalendarDate = new Date(svCalendarDate.getFullYear(), svCalendarDate.getMonth() + 1, 1); renderSvCalendar(); }
function svCalendarToday() { svCalendarDate = new Date(); renderSvCalendar(); }

function renderSvCalendar() {
    const grid = $("svCalendarGrid");
    const title = $("svCalendarTitle");
    if (!grid || !title) return;
    const year = svCalendarDate.getFullYear();
    const month = svCalendarDate.getMonth();
    title.textContent = new Date(year, month, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    const first = new Date(year, month, 1);
    const startDay = first.getDay();
    const days = new Date(year, month + 1, 0).getDate();
    const prevDays = new Date(year, month, 0).getDate();
    const events = Array.isArray(svData?.calendar?.events) ? svData.calendar.events : [];
    const eventMap = {};
    events.forEach(e => { const key = svNormalizeDate(e.date); if (key) (eventMap[key] ||= []).push(e); });
    svCalendarEventMap = eventMap;
    let html = "";
    const todayKey = formatDateKey(new Date());
    for (let i = 0; i < 42; i++) {
        const dayIndex = i - startDay + 1;
        let d, other = false;
        if (dayIndex < 1) { d = new Date(year, month - 1, prevDays + dayIndex); other = true; }
        else if (dayIndex > days) { d = new Date(year, month + 1, dayIndex - days); other = true; }
        else d = new Date(year, month, dayIndex);
        const key = formatDateKey(d);
        const dayEvents = eventMap[key] || [];
        const maxShown = window.matchMedia("(min-width: 1024px)").matches ? 3 : 2;
        html += `<div class="sv-calendar-day ${other ? "other" : ""} ${key === todayKey ? "today" : ""}" onclick="openSvDayModal('${key}')" role="button" tabindex="0">`;
        html += `<div class="sv-calendar-number">${d.getDate()}</div><div class="sv-calendar-events">`;
        dayEvents.slice(0, maxShown).forEach(e => {
            const assignment = Number(e.type) === 2;
            html += `<div class="sv-calendar-event ${assignment ? "assignment" : ""}" title="${escapeHTML(e.description || e.title || "")}">${escapeHTML(e.title || "Event")}</div>`;
        });
        if (dayEvents.length > maxShown) html += `<div class="sv-calendar-event">+${dayEvents.length - maxShown} more</div>`;
        html += `</div></div>`;
    }
    grid.innerHTML = html;
}

let svCalendarResizeTimer = null;
window.addEventListener("resize", () => {
    clearTimeout(svCalendarResizeTimer);
    svCalendarResizeTimer = setTimeout(() => {
        if ($("svCalendarGrid")?.innerHTML) renderSvCalendar();
    }, 200);
});

function openSvDayModal(dateKey) {
    const events = svCalendarEventMap[dateKey] || [];
    const d = new Date(`${dateKey}T00:00:00`);
    const titleEl = $("svDayModalTitle");
    if (titleEl) {
        titleEl.textContent = Number.isNaN(d.getTime())
            ? "Day"
            : d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    }
    const content = $("svDayModalContent");
    if (!events.length) {
        content.innerHTML = `<div class="calendar-empty"><div class="calendar-empty-icon">📅</div>No events on this day.</div>`;
    } else {
        content.innerHTML = events.map(e => {
            const assignment = Number(e.type) === 2;
            return `<div class="profile-card static" style="margin-bottom:10px;text-align:left;">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="font-size:20px;">${assignment ? "📝" : "📌"}</div>
            <div>
              <div style="font-weight:700;">${escapeHTML(e.title || "Event")}</div>
              ${e.description ? `<div style="color:var(--secondary);font-size:13px;margin-top:4px;">${escapeHTML(e.description)}</div>` : ""}
            </div>
          </div>
        </div>`;
        }).join("");
    }
    openModal("svDayModal");
}


function openSvProfileModal() {
    const d = svProfileDetails || {};
    const setText = (id, value) => { const el = $(id); if (el) el.textContent = value || "—"; };
    setText("svModalName", d.fullName);
    setText("svModalSchool", d.school);
    setText("svModalId", d.id != null ? String(d.id) : "");
    setText("svModalGender", d.gender);
    setText("svModalGrade", d.grade);
    setText("svModalUserId", d.userId);
    setText("svModalHomeAddress", d.homeAddress ? d.homeAddress.replace(/\n+/g, ", ") : d.homeAddress);
    setText("svModalPhone", d.phone);
    const basicRows = $("svModalBasicRows");
    const extraRows = $("svModalExtraRows");
    if (basicRows) basicRows.style.display = "";
    if (extraRows) extraRows.style.display = "none";
    openModal("svProfileModal");
}

function toggleSvProfileCard() {
    const basicRows = $("svModalBasicRows");
    const extraRows = $("svModalExtraRows");
    if (!basicRows || !extraRows) return;
    const showingExtra = extraRows.style.display !== "none";
    basicRows.style.display = showingExtra ? "" : "none";
    extraRows.style.display = showingExtra ? "none" : "";
}

function openSvCourseHistory() {
    closeModal("svProfileModal");
    const modal = $("svCourseHistoryModal");
    const content = $("svCourseHistoryContent");
    const historyResponse = svData?.courseHistory || {};
    const history = Array.isArray(historyResponse)
        ? historyResponse
        : (Array.isArray(historyResponse.history) ? historyResponse.history : []);
    if (!history.length) {
        content.innerHTML = `<div class="calendar-empty"><div class="calendar-empty-icon">📚</div>No course history was returned.</div>`;
    } else {
        content.innerHTML = history.map(g => `
        <div class="section-title" style="margin-top:8px;">${escapeHTML(g.grade || "Grade")}</div>
        ${(g.terms || []).map(t => `
          <div class="profile-card static" style="margin-bottom:10px;">
            <div style="font-weight:700;">${escapeHTML(t.schoolName || "School")}</div>
            <div style="color:var(--secondary);font-size:12px;margin-top:4px;">${escapeHTML([t.year, t.termName].filter(Boolean).join(" · "))}</div>
            <div style="margin-top:10px;display:flex;flex-direction:column;gap:2px;">
              ${(t.courses || []).map(c => `<div class="course-history-row"><span>${escapeHTML(c.title || "Course")}</span><strong>${escapeHTML(c.mark || "—")}</strong></div>`).join("")}
            </div>
          </div>`).join("")}
      `).join("");
    }
    modal.classList.add("show");
}

async function svDownloadTranscript() {
    const creds = load("StudentVueCreds");
    if (!creds) { alert("Connect to StudentVUE first."); return; }
    const btn = $("svTranscriptButton");
    const original = btn.textContent;
    btn.textContent = "Preparing…";
    btn.disabled = true;
    try {
        const result = await svWorkerRequestRetrying(creds, "webReport", { reportKey: "transcriptLegacy" });

        const isHomeScreen = window.navigator.standalone === true ||
            window.matchMedia("(display-mode: standalone)").matches;

        if (isHomeScreen) {
            const response = await fetch(result.dataUri);
            const blob = await response.blob();
            const pdfUrl = URL.createObjectURL(blob);
            window.open(pdfUrl, "_blank");
            setTimeout(() => URL.revokeObjectURL(pdfUrl), 60000);
        } else {
            const link = document.createElement("a");
            link.href = result.dataUri;
            link.download = result.filename || "Unofficial_Transcript.pdf";
            document.body.appendChild(link);
            link.click();
            link.remove();
        }
    } catch (err) {
        console.error("[StudentVUE]", err);
        alert(err.message || "Couldn't open the transcript.");
    } finally {
        btn.textContent = original;
        btn.disabled = false;
    }
}

function svToggleRaw() {
    const el = $("svRawResponse");
    const showing = el.style.display !== "none";
    el.style.display = showing ? "none" : "block";
    const btn = $("svRawToggleButton");
    if (btn) btn.textContent = showing ? "Show Raw Response" : "Hide Raw Response";
}

function svSignOut() {
    if (!confirm("Sign out of StudentVUE? Your saved login and cached grades on this device will be cleared.")) return;
    localStorage.removeItem("StudentVueCreds");
    localStorage.removeItem("StudentVueData");
    svData = null;
    svUnlockedThisSession = false;
    $("svWorkerUrl").value = ""; $("svPortalUrl").value = ""; $("svUsername").value = ""; $("svPassword").value = "";
    svShowLoginView();
}

function renderPasswordEntries() {
    const container = $("passwordList"); container.innerHTML = "";
    if (!passwordEntries.length) { container.innerHTML = `<div class="profile-card static"><div style="font-size:36px;">🔐</div><div style="font-size:16px;font-weight:700;margin-top:8px;">No Passwords Yet</div><div style="color:var(--secondary);font-size:13px;margin-top:5px;">Add a login or other information below.</div></div>`; return; }
    passwordEntries.forEach(entry => {
        const btn = document.createElement("button"); btn.className = "password-card"; btn.onclick = () => openPasswordDetail(entry.id);
        btn.innerHTML = `<div class="password-card-top"><div class="list-icon" style="margin-right:0;">🔐</div><div class="list-info"><div class="list-title">${escapeHTML(entry.name || "Untitled")}</div><div class="password-type">${escapeHTML(entry.website || entry.email || entry.username || entry.phone || "Login information")}</div></div><div class="arrow">›</div></div>`;
        container.appendChild(btn);
    });
}
function openPasswordDetail(id) {
    const entry = passwordEntries.find(e => e.id === id); if (!entry) return; viewingPasswordID = id;
    const text = (v) => v ? escapeHTML(v) : "—";
    $("passwordDetailTitle").textContent = entry.name || "Password";
    $("detailUsername").innerHTML = text(entry.username);
    $("detailEmail").innerHTML = text(entry.email);
    $("detailPassword").innerHTML = entry.password ? `<span style="font-family:monospace;word-break:break-all;">${escapeHTML(entry.password)}</span>` : "—";
    $("detailWebsite").innerHTML = text(entry.website);
    $("detailPhone").innerHTML = formatPhone(entry.phone) || "—";
    $("detailNotes").innerHTML = text(entry.notes);
    openModal("passwordDetailModal");
}
function closePasswordDetail() { closeModal("passwordDetailModal"); viewingPasswordID = null; }
function editPasswordFromDetail() { const id = viewingPasswordID; closePasswordDetail(); if (id !== null) openPasswordModal(id); }
function openPasswordModal(id = null) {
    editingPasswordID = id;
    const fields = ["editPasswordName", "editPasswordUsername", "editPasswordEmail", "editPasswordPassword", "editPasswordWebsite", "editPasswordPhone", "editPasswordNotes"];
    if (id === null) { $("passwordModalTitle").textContent = "Add Password / Info"; fields.forEach(x => $(x).value = ""); $("deletePasswordButton").style.display = "none"; }
    else { const entry = passwordEntries.find(e => e.id === id); if (!entry) return; $("passwordModalTitle").textContent = "Edit Password / Info"; $("editPasswordName").value = entry.name || ""; $("editPasswordUsername").value = entry.username || ""; $("editPasswordEmail").value = entry.email || ""; $("editPasswordPassword").value = entry.password || ""; $("editPasswordWebsite").value = entry.website || ""; $("editPasswordPhone").value = entry.phone || ""; $("editPasswordNotes").value = entry.notes || ""; $("deletePasswordButton").style.display = "block"; }
    setPasswordInputVisibility(false); openModal("passwordModal");
}
const EYE_ICON_PATHS = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>`;
const EYE_OFF_ICON_PATHS = `<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>`;
function setPasswordInputVisibility(show) {
    const input = $("editPasswordPassword");
    if (input) input.type = show ? "text" : "password";
    const icon = $("passwordVisibilityIcon");
    if (icon) icon.innerHTML = show ? EYE_OFF_ICON_PATHS : EYE_ICON_PATHS;
    const toggle = $("passwordVisibilityToggle");
    if (toggle) toggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
}
function togglePasswordInputVisibility() { const input = $("editPasswordPassword"); setPasswordInputVisibility(input.type === "password"); }
function savePasswordEntry() {
    const data = { name: $("editPasswordName").value.trim(), username: $("editPasswordUsername").value.trim(), email: $("editPasswordEmail").value.trim(), password: $("editPasswordPassword").value, website: $("editPasswordWebsite").value.trim(), phone: $("editPasswordPhone").value.trim(), notes: $("editPasswordNotes").value.trim() };
    if (!data.name) { alert("Please enter a name or service."); return; } if (editingPasswordID === null) { data.id = Date.now(); passwordEntries.push(data); } else { const i = passwordEntries.findIndex(e => e.id === editingPasswordID); if (i !== -1) passwordEntries[i] = { ...passwordEntries[i], ...data }; } save("PasswordEntries", passwordEntries); closeModal('passwordModal'); renderPasswordEntries();
}
function deleteCurrentPasswordEntry() { if (editingPasswordID === null) return; if (!confirm("Delete this entry?")) return; passwordEntries = passwordEntries.filter(e => e.id !== editingPasswordID); save("PasswordEntries", passwordEntries); closeModal('passwordModal'); renderPasswordEntries(); }

/* ===== RESET ===== */
let resetSlideDragging = false, resetSlideStartX = 0, resetSlideHandleStartLeft = 0, resetSlideMax = 0;

function openResetConfirm() {
    const cloudNote = $("resetConfirmCloudNote");
    if (cloudNote) cloudNote.textContent = auth.currentUser ? ", including your synced copy in the cloud" : "";
    resetSlideReset();
    openModal("resetConfirmModal");
}

function closeResetConfirm() {
    closeModal("resetConfirmModal");
    resetSlideReset();
}

function resetSlideReset() {
    const handle = $("resetSlideHandle");
    const track = $("resetSlideTrack");
    if (!handle || !track) return;
    handle.style.left = "3px";
    track.classList.remove("armed");
}

function setupResetSlideHandlers() {
    const handle = $("resetSlideHandle");
    const track = $("resetSlideTrack");
    if (!handle || !track || handle.dataset.bound) return;
    handle.dataset.bound = "1";
    handle.addEventListener("pointerdown", e => {
        resetSlideDragging = true;
        handle.classList.add("dragging");
        handle.setPointerCapture(e.pointerId);
        resetSlideStartX = e.clientX;
        resetSlideHandleStartLeft = handle.offsetLeft;
        resetSlideMax = track.clientWidth - handle.offsetWidth - 6;
    });
    handle.addEventListener("pointermove", e => {
        if (!resetSlideDragging) return;
        let newLeft = resetSlideHandleStartLeft + (e.clientX - resetSlideStartX);
        newLeft = Math.max(3, Math.min(resetSlideMax, newLeft));
        handle.style.left = newLeft + "px";
        track.classList.toggle("armed", newLeft >= resetSlideMax * 0.85);
    });
    const endDrag = () => {
        if (!resetSlideDragging) return;
        resetSlideDragging = false;
        handle.classList.remove("dragging");
        if (handle.offsetLeft >= resetSlideMax * 0.85) {
            handle.style.left = resetSlideMax + "px";
            setTimeout(performReset, 150);
        } else {
            resetSlideReset();
        }
    };
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
    handle.addEventListener("pointerleave", e => { if (resetSlideDragging && e.buttons === 0) endDrag(); });
}

function performReset() {
    SYNC_KEYS.forEach(k => localStorage.removeItem(k));
    if (auth.currentUser) {
        db.collection("users").doc(auth.currentUser.uid).delete().catch(err => console.error("Cloud reset failed:", err));
    }
    location.reload();
}

/* ===== APP ICON PICKER =====
   iOS reads <link rel="apple-touch-icon"> straight off the page the moment someone
   taps "Add to Home Screen," so updating that link's href here takes effect on the
   next add. Android/Chrome instead reads manifest.json, which a static file can't
   change on its own — so the choice is also handed to the service worker (via
   IndexedDB, since service workers can't see localStorage), which rewrites the
   manifest's icons on the fly when it's fetched. Either way, an icon already on a
   home screen won't update itself — it has to be removed and re-added. */
const ICON_OPTIONS = [
    { id: "default", name: "Classic", icon: "Icons/My Student/My Student (Classic).png", group: "My Student" },
    { id: "duotone-dark", name: "Classic Duotone Dark", icon: "Icons/My Student/My Student (Classic Duotone Dark).png", group: "My Student" },
    { id: "duotone-light", name: "Classic Duotone Light", icon: "Icons/My Student/My Student (Classic Duotone Light).png", group: "My Student" },
    { id: "Red", name: "Red", icon: "Icons/My Student/My Student (Red).png", group: "My Student" },
    { id: "blue", name: "Blue", icon: "Icons/My Student/My Student (Blue).png", group: "My Student" },
    { id: "green", name: "Green", icon: "Icons/My Student/My Student (Green).png", group: "My Student" },
    { id: "purple", name: "Purple", icon: "Icons/My Student/My Student (Purple).png", group: "My Student" },
    { id: "teal", name: "Teal", icon: "Icons/My Student/My Student (Teal).png", group: "My Student" },
    { id: "gold", name: "Gold", icon: "Icons/My Student/My Student (Gold).png", group: "My Student" },
    // Add more StudentVUE-branded icon files to the Icons folder using
    // this same "StudentVUE (Name).png" naming pattern, then add an
    // entry here — the picker below groups automatically by "group".
    { id: "sv-classic", name: "Classic", icon: "Icons/StudentVUE/StudentVUE (Classic).png", group: "StudentVUE" },
    { id: "sv-classic-inversed", name: "Classic Inversed", icon: "Icons/StudentVUE/StudentVUE (Classic Inversed).png", group: "StudentVUE" },
    { id: "sv-outline", name: "Outline", icon: "Icons/StudentVUE/StudentVUE (Outline).png", group: "StudentVUE" },
    { id: "sv-no-outline", name: "No Outline", icon: "Icons/StudentVUE/StudentVUE (No Outline).png", group: "StudentVUE" },
    { id: "sv-pink", name: "Pink", icon: "Icons/StudentVUE/StudentVUE (Pink).png", group: "StudentVUE" },
    { id: "sv-gold", name: "Gold", icon: "Icons/StudentVUE/StudentVUE (Gold).png", group: "StudentVUE" },
    { id: "sv-blue", name: "Blue", icon: "Icons/StudentVUE/StudentVUE (Blue).png", group: "StudentVUE" },
    { id: "sv-purple", name: "Purple", icon: "Icons/StudentVUE/StudentVUE (Purple).png", group: "StudentVUE" },
    { id: "sv-green", name: "Green", icon: "Icons/StudentVUE/StudentVUE (Green).png", group: "StudentVUE" }
];
const APP_ICON_CHOICE_KEY = "AppIconChoice";

function getAppIconChoiceId() {
    return localStorage.getItem(APP_ICON_CHOICE_KEY) || ICON_OPTIONS[0].id;
}

function applyStoredAppIconLinks() {
    const opt = ICON_OPTIONS.find(o => o.id === getAppIconChoiceId()) || ICON_OPTIONS[0];
    const appleLink = $("appleTouchIconLink");
    const altLink = $("alternateIconLink");
    if (appleLink) appleLink.href = opt.icon;
    if (altLink) altLink.href = opt.icon;
    const previewImg = $("currentAppIconPreviewImg");
    if (previewImg) { previewImg.src = opt.icon; previewImg.alt = opt.name; }
}

const APP_ICON_GROUPS = [...new Set(ICON_OPTIONS.map(o => o.group))];
let appIconGroupView = APP_ICON_GROUPS[0];

function openAppIconModal() {
    // Default the switcher to whichever group the current icon belongs
    // to, so opening the picker shows your active icon right away.
    const current = ICON_OPTIONS.find(o => o.id === getAppIconChoiceId());
    appIconGroupView = current ? current.group : APP_ICON_GROUPS[0];
    renderAppIconGroupSwitcher();
    renderAppIconOptions();
    openModal("appIconModal");
}

function renderAppIconGroupSwitcher() {
    const wrap = $("appIconGroupSwitcher");
    if (!wrap) return;
    wrap.innerHTML = APP_ICON_GROUPS.map(g => `
      <button type="button" class="view-button ${g === appIconGroupView ? "active" : ""}"
        onclick="changeAppIconGroup('${g.replace(/'/g, "\\'")}')">${escapeHTML(g)}</button>
    `).join("");
}

function changeAppIconGroup(group) {
    appIconGroupView = group;
    renderAppIconGroupSwitcher();
    renderAppIconOptions();
}

function renderAppIconOptions() {
    const wrap = $("appIconOptionsList");
    if (!wrap) return;
    const current = getAppIconChoiceId();
    const items = ICON_OPTIONS.filter(opt => opt.group === appIconGroupView);
    wrap.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:14px;justify-content:center;">
        ${items.map(opt => `
          <button type="button" class="app-icon-option ${opt.id === current ? "selected" : ""}"
            onclick="selectAppIcon('${opt.id}')">
            <img src="${opt.icon}" alt="${escapeHTML(opt.name)}">
            <span>${escapeHTML(opt.name)}</span>
          </button>
        `).join("")}
      </div>
    `;
}

function selectAppIcon(id) {
    const opt = ICON_OPTIONS.find(o => o.id === id);
    if (!opt) return;
    localStorage.setItem(APP_ICON_CHOICE_KEY, id);
    applyStoredAppIconLinks();
    storeIconChoiceForServiceWorker(opt.icon);
    renderAppIconOptions();
}

function storeIconChoiceForServiceWorker(icon) {
    try {
        const dbReq = indexedDB.open("AppHubIconDB", 1);
        dbReq.onupgradeneeded = () => dbReq.result.createObjectStore("settings");
        dbReq.onsuccess = () => {
            const db = dbReq.result;
            const tx = db.transaction("settings", "readwrite");
            tx.objectStore("settings").put({ icon192: icon, icon512: icon }, "iconChoice");
        };
    } catch (e) { /* IndexedDB unavailable — icon still applies via the link tags above */ }
}

/* ===== START ===== */
loadDarkMode();
loadSidebarCollapsed();
loadDefaultToStudentVuePref();
loadSvAutoLoginPref();
applyStoredAppIconLinks();
renderAccountUI(auth.currentUser);
renderRecentAccounts();
renderProfile();
renderSchoolInfo();
renderClasses();
renderCalendar();
renderHomeLinks();
renderTimerDisplay();
setupAvatarCropDragHandlers();
setupResetSlideHandlers();
applyDefaultStartupPage();