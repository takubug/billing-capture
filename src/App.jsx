import { useState, useRef, useCallback } from "react";

// ── Brand ─────────────────────────────────────────────────────────────────────
// OA Surgery brand colours
// Forest Floor #002521 | Forest Biome #194B46 | Chalk Blue #BFCDCC
// Light Turquoise #84C4C0 | Bright Jade #CFF4D2 | White #FFFFFF | Black #27272A


// ── Helpers ───────────────────────────────────────────────────────────────────

const ANTHROPIC_MODEL = "claude-sonnet-4-6";
const PROXY_URL = "https://billing-capture.oscar-137.workers.dev/";

async function extractLabelData(base64Image, mediaType) {
  const response = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
          { type: "text", text: `You are a medical administrative assistant. Extract all available patient information from this Australian patient label image.
Return ONLY a valid JSON object with these exact keys (use null if not found):
{
  "patientName": string | null,
  "dob": string | null,
  "medicareNumber": string | null,
  "medicareIRN": string | null,
  "medicareExpiry": string | null,
  "address": string | null,
  "insurer": string | null,
  "insuranceNumber": string | null,
  "referrer": string | null,
  "gp": string | null
}
Formatting rules - follow these exactly:
- correct all words to sentence case.
- "dob": convert to YYYY-MM-DD format regardless of how it appears on the label (e.g. "12/03/1975" or "12 Mar 1975" or "12-03-75" should all become "1975-03-12"). For two-digit years, assume 19xx if the result would be a plausible adult DOB.
- "medicareNumber": the 10-digit number only, no spaces or hyphens.
- "medicareIRN": the single digit that follows the medicare number (the Individual Reference Number).
- "patientName": format as "Firstname LASTNAME".
- "address": include full address on one line if visible.
- "insurer": will follow the letters PVT and will be a three letter code.
- "insuranceNumber": will follow the insurer and will be a string of numbers and/or letters.
- If a field is partially visible or ambiguous, make your best inference rather than returning null.
No markdown, no explanation, just the JSON object.` }
        ]
      }]
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `API error ${response.status}`);
  const text = data.content?.find((b) => b.type === "text")?.text || "{}";
  try { return JSON.parse(text.replace(/```json|```/g, "").trim()); }
  catch { return {}; }
}

// ── Google Drive ──────────────────────────────────────────────────────────────

const DRIVE_FOLDER_NAME = "MediSnap";

async function getOrCreateDriveFolder(accessToken) {
  const search = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=name%3D'${DRIVE_FOLDER_NAME}'+and+mimeType%3D'application%2Fvnd.google-apps.folder'+and+trashed%3Dfalse&fields=files(id)`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!search.ok) throw new Error(`Drive folder search failed (${search.status}): ${await search.text()}`);
  const searchData = await search.json();
  if (searchData.files?.length > 0) return searchData.files[0].id;
  const create = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
  });
  if (!create.ok) throw new Error(`Drive folder create failed (${create.status}): ${await create.text()}`);
  const createData = await create.json();
  return createData.id;
}

async function uploadImageToDrive(accessToken, file, patientName, timestamp) {
  const folderId = await getOrCreateDriveFolder(accessToken);
  const ext = file.name?.split(".").pop() || "jpg";
  const safeName = (patientName || "unknown").replace(/[^a-z0-9]/gi, "_");
  const fileName = `${safeName}_${timestamp.replace(/[:.]/g, "-")}.${ext}`;
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ name: fileName, parents: [folderId] })], { type: "application/json" }));
  form.append("file", file);
  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
    { method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: form }
  );
  if (!res.ok) throw new Error(`Drive upload failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.webViewLink || null;
}

// ── Google Sheets ─────────────────────────────────────────────────────────────

async function appendToSheet(sheetId, accessToken, rowData) {
  const values = [[
    rowData.timestamp, rowData.patientName ?? "", rowData.dob ?? "",
    rowData.medicareNumber ?? "", rowData.medicareIRN ?? "", rowData.medicareExpiry ?? "",
    rowData.address ?? "", rowData.insurer ?? "", rowData.insuranceNumber ?? "",
    rowData.referrer ?? "", rowData.gp ?? "", rowData.serviceCode,
    rowData.dateOfService, rowData.imageUrl ?? "",
  ]];
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ values }) }
  );
  return res.ok;
}

async function createSheet(accessToken) {
  const res = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: { title: "MediSnap Patient Records" },
      sheets: [{ properties: { title: "Sheet1" }, data: [{ startRow: 0, startColumn: 0, rowData: [{ values: [
        "Timestamp","Patient Name","DOB","Medicare Number","Medicare IRN","Medicare Expiry",
        "Address","Insurer","Insurance Number","Referrer","GP","Service Code","Date of Service","Label Image"
      ].map((v) => ({ userEnteredValue: { stringValue: v } })) }] }] }],
    }),
  });
  if (!res.ok) throw new Error(`Sheet create failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.spreadsheetId;
}

async function getSheetData(sheetId, accessToken) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Sheet read failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.values || [];
}

async function sendEmail(accessToken, toEmail, subject, body) {
  const message = [`To: ${toEmail}`, `Subject: ${subject}`, "", body].join("\n");
  const encoded = btoa(unescape(encodeURIComponent(message))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: encoded }),
  });
  return res.ok;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ base64: reader.result.split(",")[1], mediaType: file.type });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Google OAuth ──────────────────────────────────────────────────────────────

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/drive.file",
].join(" ");

function useGoogleAuth() {
  const [accessToken, setAccessToken] = useState(null);
  const [userEmail, setUserEmail] = useState(null);
  const [clientId, setClientId] = useState(() => { try { return localStorage.getItem("clientId") || ""; } catch { return ""; } });
  const [showClientIdInput, setShowClientIdInput] = useState(false);

  const signIn = useCallback(() => {
    if (!clientId.trim()) { setShowClientIdInput(true); return; }
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: window.location.origin + window.location.pathname,
      response_type: "token", scope: SCOPES, include_granted_scopes: "true",
    });
    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }, [clientId]);

  const parseToken = useCallback(() => {
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    const token = params.get("access_token");
    if (token) {
      setAccessToken(token);
      window.location.hash = "";
      fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => r.json()).then((d) => setUserEmail(d.email));
    }
  }, []);

  return { accessToken, userEmail, clientId, setClientId, showClientIdInput, setShowClientIdInput, signIn, parseToken };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const EMPTY_FIELDS = {
  patientName: "", dob: "", medicareNumber: "", medicareIRN: "", medicareExpiry: "",
  address: "", insurer: "", insuranceNumber: "", referrer: "", gp: "",
  serviceCode: "", dateOfService: new Date().toISOString().split("T")[0],
};

const FIELD_LABELS = {
  patientName: "Patient Name", dob: "Date of Birth", medicareNumber: "Medicare Number",
  medicareIRN: "Medicare IRN", medicareExpiry: "Medicare Expiry", address: "Address",
  insurer: "Insurer", insuranceNumber: "Insurance Number", referrer: "Referrer",
  gp: "GP", serviceCode: "Service Code", dateOfService: "Date of Service",
};

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const auth = useGoogleAuth();
  const [step, setStep] = useState("capture");
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [fields, setFields] = useState(EMPTY_FIELDS);
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const [toast, setToast] = useState(null);
  const [sheetId, setSheetId] = useState(() => { try { return localStorage.getItem("sheetId") || ""; } catch { return ""; } });
  const [reportFilter, setReportFilter] = useState({ serviceCode: "", dateFrom: "", dateTo: "" });
  const [reportLoading, setReportLoading] = useState(false);
  const fileInputRef = useRef();
  const cameraInputRef = useRef();

  useState(() => { auth.parseToken(); });

  const showToast = (msg, type = "success") => { setToast({ msg, type }); setTimeout(() => setToast(null), 3500); };

  const handleFile = async (file) => {
    if (!file) return;
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
    setExtracting(true);
    setStep("review");
    try {
      const { base64, mediaType } = await fileToBase64(file);
      const extracted = await extractLabelData(base64, mediaType);
      setFields((f) => ({ ...f, ...Object.fromEntries(Object.entries(extracted).map(([k, v]) => [k, v ?? ""])) }));
    } catch (e) {
      console.error("Extraction error:", e);
      showToast(`Extraction failed: ${e?.message || "check console"}`, "error");
    } finally { setExtracting(false); }
  };

  const handleSave = async () => {
    if (!auth.accessToken) { showToast("Please sign in to Google first.", "error"); return; }
    if (!fields.serviceCode) { showToast("Service code is required.", "error"); return; }
    setSaving(true);
    try {
      let sid = sheetId;
      if (!sid) {
        sid = await createSheet(auth.accessToken);
        setSheetId(sid);
        try { localStorage.setItem("sheetId", sid); } catch {}
      }
      const timestamp = new Date().toISOString();
      let imageUrl = "";
      if (imageFile) {
        setSaveStatus("Uploading image to Drive…");
        try { imageUrl = await uploadImageToDrive(auth.accessToken, imageFile, fields.patientName, timestamp) || ""; }
        catch (e) {
          console.warn("Image upload failed:", e);
          showToast(`Image upload failed: ${e?.message?.slice(0, 120) || "see console"}. Saving record without image.`, "error");
        }
      }
      setSaveStatus("Saving to Sheets…");
      const ok = await appendToSheet(sid, auth.accessToken, { ...fields, timestamp, imageUrl });
      if (ok) {
        showToast("Record saved ✓");
        setStep("capture"); setFields(EMPTY_FIELDS); setImagePreview(null); setImageFile(null);
      } else { showToast("Save failed — check sheet permissions.", "error"); }
    } catch (e) { showToast("Error: " + e.message, "error"); }
    finally { setSaving(false); setSaveStatus(""); }
  };

  const handleReport = async () => {
    if (!auth.accessToken || !auth.userEmail) { showToast("Please sign in first.", "error"); return; }
    if (!sheetId) { showToast("No sheet found — save a record first.", "error"); return; }
    setReportLoading(true);
    try {
      const rows = await getSheetData(sheetId, auth.accessToken);
      if (rows.length < 2) { showToast("No data yet.", "error"); setReportLoading(false); return; }
      const [header, ...data] = rows;
      const idx = Object.fromEntries(header.map((h, i) => [h, i]));
      let filtered = data;
      if (reportFilter.serviceCode) filtered = filtered.filter((r) => (r[idx["Service Code"]] || "").toLowerCase().includes(reportFilter.serviceCode.toLowerCase()));
      if (reportFilter.dateFrom) filtered = filtered.filter((r) => (r[idx["Date of Service"]] || "") >= reportFilter.dateFrom);
      if (reportFilter.dateTo) filtered = filtered.filter((r) => (r[idx["Date of Service"]] || "") <= reportFilter.dateTo);
      const grouped = {};
      for (const r of filtered) { const name = r[idx["Patient Name"]] || "Unknown"; if (!grouped[name]) grouped[name] = []; grouped[name].push(r); }
      let body = `Patient Billing Report\nGenerated: ${new Date().toLocaleString("en-AU")}\n`;
      if (reportFilter.serviceCode) body += `Service Code Filter: ${reportFilter.serviceCode}\n`;
      if (reportFilter.dateFrom) body += `From: ${reportFilter.dateFrom}\n`;
      if (reportFilter.dateTo) body += `To: ${reportFilter.dateTo}\n`;
      body += `\n${"─".repeat(60)}\n\n`;
      for (const [patient, records] of Object.entries(grouped)) {
        body += `PATIENT: ${patient}\n  DOB: ${records[0][idx["DOB"]] || "—"}  |  Medicare: ${records[0][idx["Medicare Number"]] || "—"}  IRN: ${records[0][idx["Medicare IRN"]] || "—"}  Exp: ${records[0][idx["Medicare Expiry"]] || "—"}\n  GP: ${records[0][idx["GP"]] || "—"}  |  Referrer: ${records[0][idx["Referrer"]] || "—"}\n  Insurer: ${records[0][idx["Insurer"]] || "—"}  |  Insurance #: ${records[0][idx["Insurance Number"]] || "—"}\n\n  Services:\n`;
        for (const r of records) { const imgNote = r[idx["Label Image"]] ? `  📎 ${r[idx["Label Image"]]}` : ""; body += `    • ${r[idx["Date of Service"]] || "?"}  –  ${r[idx["Service Code"]] || "?"}${imgNote}\n`; }
        body += `\n${"─".repeat(60)}\n\n`;
      }
      body += `Total records: ${filtered.length} across ${Object.keys(grouped).length} patient(s)\n\nView full sheet: https://docs.google.com/spreadsheets/d/${sheetId}`;
      const subject = `Billing Report${reportFilter.serviceCode ? ` – ${reportFilter.serviceCode}` : ""} – ${new Date().toLocaleDateString("en-AU")}`;
      const ok = await sendEmail(auth.accessToken, auth.userEmail, subject, body);
      if (ok) showToast(`Report emailed to ${auth.userEmail} ✓`);
      else showToast("Email failed — check Gmail permissions.", "error");
    } catch (e) { showToast("Error: " + e.message, "error"); }
    finally { setReportLoading(false); }
  };

  const s = styles;

  return (
    <div style={s.root}>
      {/* Inject Google Font */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap');
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
        * { box-sizing: border-box; }
        input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(0.7); }
      `}</style>

      {/* Toast */}
      {toast && (
        <div style={{ ...s.toast, background: toast.type === "error" ? "#7a1a1a" : "#194B46", borderLeft: toast.type === "error" ? "3px solid #ff6b6b" : "3px solid #CFF4D2" }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <header style={s.header}>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500" style={s.logo} aria-label="OA Surgery">
            <defs><style>{`.oa-logo{fill:#1a4b46;}`}</style></defs>
            <path className="oa-logo" d="M194.07,259.85a71,71,0,0,0,28.21-26.54q10.14-16.94,10.13-38.22,0-21-10.13-37.83A70.38,70.38,0,0,0,194.07,131q-18.07-9.49-40.65-9.49-22.83,0-40.78,9.49A72.13,72.13,0,0,0,84.3,157.39a72.7,72.7,0,0,0,28.21,102.46q18.09,9.61,40.91,9.62Q176,269.47,194.07,259.85Zm-72.58-45a40.65,40.65,0,0,1-4.74-19.75,39.2,39.2,0,0,1,4.74-19.49,34.39,34.39,0,0,1,13-13.21,37.27,37.27,0,0,1,19-4.74,36.74,36.74,0,0,1,18.72,4.74,34.49,34.49,0,0,1,13,13.21,43.52,43.52,0,0,1,0,39.5,34.39,34.39,0,0,1-13,13.2,36.15,36.15,0,0,1-18.46,4.75,37.89,37.89,0,0,1-19.11-4.75A33.58,33.58,0,0,1,121.49,214.84Z"/><path className="oa-logo" d="M293.76,244.33h62l8.52,22.06h45.39L347.31,124.31H302.17L239.59,266.39h45.66Zm31.75-78.22,19.91,51.55H304.06L324,166.11Z"/><path className="oa-logo" d="M105,322.19a48.64,48.64,0,0,0-11-3.34,54.44,54.44,0,0,1-7.83-2.14,9.73,9.73,0,0,1-4-2.5,5.19,5.19,0,0,1-1.2-3.47,5.62,5.62,0,0,1,1.29-3.7,8,8,0,0,1,3.65-2.36,18.17,18.17,0,0,1,5.75-.8,33.46,33.46,0,0,1,8.68,1.16,24,24,0,0,1,7.53,3.38l2.85-5.61a26.93,26.93,0,0,0-8.55-3.7A39.93,39.93,0,0,0,92,297.73a25.62,25.62,0,0,0-9.53,1.61,13,13,0,0,0-6.1,4.67,12.55,12.55,0,0,0-2.09,7.26,11.76,11.76,0,0,0,1.6,6.33A12.13,12.13,0,0,0,81.38,322a50,50,0,0,0,10.69,3.12,56.65,56.65,0,0,1,8.15,2,9.69,9.69,0,0,1,4.19,2.53,5.71,5.71,0,0,1,1.29,3.83,6.51,6.51,0,0,1-1.51,4.37,8.88,8.88,0,0,1-4.32,2.63,24,24,0,0,1-6.82.84A29.33,29.33,0,0,1,84,339.82a32.77,32.77,0,0,1-8.55-4.23l-2.86,5.53a32.75,32.75,0,0,0,9.31,4.58,35.08,35.08,0,0,0,10.83,1.74,29.83,29.83,0,0,0,10.46-1.65,14.65,14.65,0,0,0,6.82-4.85,12.42,12.42,0,0,0,2.4-7.66,11.93,11.93,0,0,0-1.69-6.51A13.24,13.24,0,0,0,105,322.19Z"/><path className="oa-logo" d="M306.27,300.63a22.68,22.68,0,0,0-11.63-3,25.34,25.34,0,0,0-12.82,3.21,22.24,22.24,0,0,0-8.69,8.86,26.38,26.38,0,0,0-3.07,12.79,25.41,25.41,0,0,0,3.25,12.83,23.12,23.12,0,0,0,9,8.9A28.13,28.13,0,0,0,306,345.35a25,25,0,0,0,8.33-5.93l-4.28-3.92a18.13,18.13,0,0,1-6.28,4.41,20.73,20.73,0,0,1-8.06,1.47,20.37,20.37,0,0,1-9.26-2.05,16.9,16.9,0,0,1-6.59-5.74,17.76,17.76,0,0,1-2.94-8.51h39.82c.05-.83.11-1.56.17-2.18s.09-1.23.09-1.83a25.63,25.63,0,0,0-2.8-12.16A20.53,20.53,0,0,0,306.27,300.63ZM277,319.29a18.32,18.32,0,0,1,2.89-8.11,16.19,16.19,0,0,1,6.15-5.52,18.49,18.49,0,0,1,8.59-2,16.33,16.33,0,0,1,7.8,1.83,14.07,14.07,0,0,1,5.52,5.34,19,19,0,0,1,2.45,8.42Z"/><path className="oa-logo" d="M343,300.81a18.85,18.85,0,0,0-6.14,7.52v-9.88h-6.68v48.19h6.68v-22a27.59,27.59,0,0,1,1.78-10.11,16.61,16.61,0,0,1,5.21-7.27,12.74,12.74,0,0,1,8.06-2.67,16,16,0,0,1,4.37.63l.26-6.86a26.41,26.41,0,0,0-4.45-.45A15.18,15.18,0,0,0,343,300.81Z"/><path className="oa-logo" d="M403.68,298.45,386.4,339l-17.2-40.53h-7.3l21,48.1-1.42,3a14.82,14.82,0,0,1-4.1,5.7,9.83,9.83,0,0,1-6.15,1.78,16.37,16.37,0,0,1-3.29-.35,9.9,9.9,0,0,1-3-1.16l-2.23,4.72a12.22,12.22,0,0,0,3.88,1.78,17.47,17.47,0,0,0,4.85.71,19.29,19.29,0,0,0,7.26-1.24,14.14,14.14,0,0,0,5.3-3.75,24.69,24.69,0,0,0,4-6.59l23-52.73Z"/><path className="oa-logo" d="M162.09,323.39a18.58,18.58,0,0,1-2.27,9.22,16.88,16.88,0,0,1-6.15,6.37,16.29,16.29,0,0,1-8.5,2.31q-6.69,0-10.38-4.05T131.09,326V298.45h-6.68v28.41a23.62,23.62,0,0,0,2.4,10.92,17.44,17.44,0,0,0,6.73,7.21,19.61,19.61,0,0,0,10.11,2.54,21.7,21.7,0,0,0,7.88-1.43,19.45,19.45,0,0,0,6.33-3.83,21.24,21.24,0,0,0,4.23-5.25v9.62h6.59V298.45h-6.59Z"/><path className="oa-logo" d="M259.55,339q-4.91-3.24-14.08-3.25H231.75a7.2,7.2,0,0,1-4.14-1,3.51,3.51,0,0,1-1.47-3.08,3.66,3.66,0,0,1,.89-2.4,6.47,6.47,0,0,1,2.85-1.78,26.84,26.84,0,0,0,10,1.78,25.87,25.87,0,0,0,10.51-2,15.64,15.64,0,0,0,6.86-5.52,14.82,14.82,0,0,0,2.41-8.47,12.87,12.87,0,0,0-1.39-6,12,12,0,0,0-3.78-4.36l8.28-1.34-1.51-5.52L249,299.25a22.09,22.09,0,0,0-9.27-1.7,26.65,26.65,0,0,0-10.6,1.92,15.29,15.29,0,0,0-6.86,5.48,14.62,14.62,0,0,0-2.4,8.37,14.07,14.07,0,0,0,5.7,11.94,9.88,9.88,0,0,0-4.32,3.21,7.64,7.64,0,0,0-1.65,4.81,7.13,7.13,0,0,0,1.29,4.41,8.19,8.19,0,0,0,3.88,3,15.6,15.6,0,0,0-5.48,4.14,8.45,8.45,0,0,0-2.1,5.48q0,5.79,5.75,9.09t16,3.29a46.33,46.33,0,0,0,13.85-1.82,19.09,19.09,0,0,0,8.73-5.21,11.51,11.51,0,0,0,3-7.84A10.07,10.07,0,0,0,259.55,339ZM228,307.93a9.67,9.67,0,0,1,4.54-3.34,20.17,20.17,0,0,1,7.26-1.16q6.33,0,9.8,2.63a8.58,8.58,0,0,1,3.47,7.26,9,9,0,0,1-6.1,8.91,19.88,19.88,0,0,1-7.17,1.16q-6.42,0-9.89-2.67A9.8,9.8,0,0,1,228,307.93Zm27.61,44.9a14.11,14.11,0,0,1-6.28,2.85,46.23,46.23,0,0,1-10.06.94,39.48,39.48,0,0,1-8.38-.76,11.69,11.69,0,0,1-5.21-2.36,5.31,5.31,0,0,1-1.83-4.19,6,6,0,0,1,1.56-3.92,15,15,0,0,1,4.59-3.47h13.72q6.94,0,10.51,1.51c2.38,1,3.56,2.59,3.56,4.72A6,6,0,0,1,255.58,352.83Z"/><path className="oa-logo" d="M197.63,300.81a18.85,18.85,0,0,0-6.14,7.52v-9.88h-6.68v48.19h6.68v-22a27.59,27.59,0,0,1,1.78-10.11,16.61,16.61,0,0,1,5.21-7.27,12.74,12.74,0,0,1,8.06-2.67,16,16,0,0,1,4.37.63l.26-6.86a26.41,26.41,0,0,0-4.45-.45A15.18,15.18,0,0,0,197.63,300.81Z"/>
          </svg>
        <div style={s.headerRight}>
          {auth.accessToken ? (
            <span style={s.signedIn}>● {auth.userEmail || "Signed in"}</span>
          ) : (
            <button style={s.signInBtn} onClick={auth.signIn}>Sign in with Google</button>
          )}
        </div>
      </header>

      {/* App title bar */}
      <div style={s.titleBar}>
        <span style={s.titleBarText}>MediSnap</span>
      </div>

      {/* Client ID modal */}
      {auth.showClientIdInput && (
        <div style={s.modal}>
          <div style={s.modalBox}>
            <h3 style={s.modalTitle}>Google API Setup</h3>
            <p style={s.modalText}>
              Enter your Google OAuth Client ID. Create one at{" "}
              <a href="https://console.cloud.google.com" target="_blank" rel="noreferrer" style={s.link}>console.cloud.google.com</a>{" "}
              with Sheets, Gmail, Drive and OAuth APIs enabled.
            </p>
            <input style={s.input} placeholder="xxxx.apps.googleusercontent.com" value={auth.clientId}
              onChange={(e) => { auth.setClientId(e.target.value); try { localStorage.setItem("clientId", e.target.value); } catch {} }} />
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button style={s.btn} onClick={() => { auth.setShowClientIdInput(false); auth.signIn(); }}>Connect</button>
              <button style={{ ...s.btn, background: "transparent", border: "1px solid #BFCDCC", color: "#BFCDCC" }} onClick={() => auth.setShowClientIdInput(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Nav */}
      <nav style={s.nav}>
        {["capture", "review", "report", "settings"].map((t) => (
          <button key={t} style={{ ...s.navBtn, ...(step === t ? s.navBtnActive : {}) }} onClick={() => setStep(t)}>
            {{"capture": "📷 Capture", "review": "✏️ Review", "report": "📊 Report", "settings": "⚙️ Settings"}[t]}
          </button>
        ))}
      </nav>

      <main style={s.main}>

        {/* ── CAPTURE ── */}
        {step === "capture" && (
          <div style={s.card}>
            <h2 style={s.cardTitle}>Scan Patient Label</h2>
            <p style={s.hint}>Take a photo or upload an image of the patient label. Data will be extracted automatically.</p>
            <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
              <button style={s.captureBtn} onClick={() => cameraInputRef.current?.click()}>
                <span style={{ fontSize: 32 }}>📷</span><span>Take Photo</span>
              </button>
              <button style={s.captureBtn} onClick={() => fileInputRef.current?.click()}>
                <span style={{ fontSize: 32 }}>🖼️</span><span>Upload Image</span>
              </button>
            </div>
            <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={(e) => handleFile(e.target.files[0])} />
            <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => handleFile(e.target.files[0])} />
            <div style={s.divider}>or</div>
            <button style={{ ...s.btn, width: "100%" }} onClick={() => setStep("review")}>Enter Manually</button>
          </div>
        )}

        {/* ── REVIEW ── */}
        {step === "review" && (
          <div style={s.card}>
            <h2 style={s.cardTitle}>Review &amp; Save</h2>
            {imagePreview && (
              <div style={s.previewWrap}>
                <img src={imagePreview} alt="Patient label" style={s.preview} />
              </div>
            )}
            {extracting && (
              <div style={s.extracting}>
                <div style={s.spinner} /><span>Extracting data from label…</span>
              </div>
            )}
            <div style={s.fieldGrid}>
              {Object.entries(FIELD_LABELS).map(([key, label]) => (
                <div key={key} style={key === "address" ? { ...s.fieldGroup, gridColumn: "1 / -1" } : s.fieldGroup}>
                  <label style={s.label}>{label}</label>
                  <input
                    style={{ ...s.input, borderColor: key === "serviceCode" && !fields[key] ? "#ff6b6b" : undefined }}
                    type={key === "dateOfService" || key === "dob" ? "date" : "text"}
                    value={fields[key]}
                    onChange={(e) => setFields((f) => ({ ...f, [key]: e.target.value }))}
                    placeholder={key === "serviceCode" ? "Required" : ""}
                  />
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button style={{ ...s.btn, background: "transparent", border: "1px solid #BFCDCC", color: "#BFCDCC", flex: 1 }}
                onClick={() => { setStep("capture"); setImagePreview(null); setImageFile(null); setFields(EMPTY_FIELDS); }}>← Back</button>
              <button style={{ ...s.btn, flex: 2 }} onClick={handleSave} disabled={saving || extracting}>
                {saving ? (saveStatus || "Saving…") : "Save to Google Sheets"}
              </button>
            </div>
          </div>
        )}

        {/* ── REPORT ── */}
        {step === "report" && (
          <div style={s.card}>
            <h2 style={s.cardTitle}>Email Report</h2>
            <p style={s.hint}>Filter records and email a summary to {auth.userEmail || "your Gmail"}.</p>
            <div style={s.fieldGroup}>
              <label style={s.label}>Service Code (partial match, optional)</label>
              <input style={s.input} value={reportFilter.serviceCode}
                onChange={(e) => setReportFilter((f) => ({ ...f, serviceCode: e.target.value }))} placeholder="e.g. 30088" />
            </div>
            <div style={{ ...s.fieldGrid, marginTop: 12 }}>
              <div style={s.fieldGroup}>
                <label style={s.label}>Date of Service — From</label>
                <input style={s.input} type="date" value={reportFilter.dateFrom}
                  onChange={(e) => setReportFilter((f) => ({ ...f, dateFrom: e.target.value }))} />
              </div>
              <div style={s.fieldGroup}>
                <label style={s.label}>Date of Service — To</label>
                <input style={s.input} type="date" value={reportFilter.dateTo}
                  onChange={(e) => setReportFilter((f) => ({ ...f, dateTo: e.target.value }))} />
              </div>
            </div>
            <button style={{ ...s.btn, width: "100%", marginTop: 16 }} onClick={handleReport} disabled={reportLoading || !auth.accessToken}>
              {reportLoading ? "Generating…" : "📧 Send Report to My Email"}
            </button>
            {sheetId && (
              <a href={`https://docs.google.com/spreadsheets/d/${sheetId}`} target="_blank" rel="noreferrer" style={s.sheetLink}>
                View full spreadsheet ↗
              </a>
            )}
          </div>
        )}

        {/* ── SETTINGS ── */}
        {step === "settings" && (
          <div style={s.card}>
            <h2 style={s.cardTitle}>Settings</h2>
            <div style={s.fieldGroup}>
              <label style={s.label}>Google OAuth Client ID</label>
              <input style={s.input} value={auth.clientId}
                onChange={(e) => { auth.setClientId(e.target.value); try { localStorage.setItem("clientId", e.target.value); } catch {} }}
                placeholder="xxxx.apps.googleusercontent.com" />
              <p style={s.hint}>Create at <a href="https://console.cloud.google.com" target="_blank" rel="noreferrer" style={s.link}>console.cloud.google.com</a>. Enable Sheets, Gmail and Drive APIs.</p>
            </div>
            <div style={{ ...s.fieldGroup, marginTop: 12 }}>
              <label style={s.label}>Google Sheet ID</label>
              <input style={s.input} value={sheetId}
                onChange={(e) => { setSheetId(e.target.value); try { localStorage.setItem("sheetId", e.target.value); } catch {} }}
                placeholder="Auto-created on first save, or paste existing ID" />
            </div>
            <button style={{ ...s.btn, marginTop: 16 }} onClick={auth.signIn}>
              {auth.accessToken ? "Re-authenticate Google" : "Connect Google Account"}
            </button>
            <div style={s.checklist}>
              <strong style={{ color: "#CFF4D2" }}>Setup checklist:</strong>
              <ol style={{ paddingLeft: 18, margin: "8px 0 0", color: "#BFCDCC" }}>
                <li>Google Cloud Console → New Project</li>
                <li>Enable Sheets API, Gmail API, Drive API</li>
                <li>OAuth consent screen → External → add Gmail as test user</li>
                <li>Credentials → OAuth 2.0 Client ID → Web application</li>
                <li>Add this page URL as authorised redirect URI</li>
                <li>Paste Client ID above → Re-authenticate Google</li>
              </ol>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  root: {
    minHeight: "100vh",
    background: "#002521",
    color: "#FFFFFF",
    fontFamily: "'DM Sans', sans-serif",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 20px",
    background: "#FFFFFF",
    borderBottom: "3px solid #194B46",
  },
  logo: {
    height: 36,
    width: "auto",
  },
  headerRight: {},
  signedIn: { fontSize: 12, color: "#194B46", fontWeight: 500 },
  signInBtn: {
    background: "#194B46",
    color: "#FFFFFF",
    border: "none",
    borderRadius: 6,
    padding: "7px 16px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
    letterSpacing: 0.3,
  },
  titleBar: {
    background: "linear-gradient(135deg, #194B46 0%, #002521 100%)",
    padding: "10px 20px",
    borderBottom: "1px solid #84C4C0",
  },
  titleBarText: {
    fontSize: 13,
    fontWeight: 600,
    color: "#CFF4D2",
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  nav: {
    display: "flex",
    background: "#27272A",
    borderBottom: "1px solid #194B46",
    overflowX: "auto",
  },
  navBtn: {
    flex: 1,
    padding: "11px 4px",
    background: "none",
    border: "none",
    color: "#BFCDCC",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    borderBottom: "2px solid transparent",
    whiteSpace: "nowrap",
    fontFamily: "inherit",
    transition: "color 0.2s",
    letterSpacing: 0.2,
  },
  navBtnActive: {
    color: "#CFF4D2",
    borderBottomColor: "#84C4C0",
  },
  main: { flex: 1, padding: "16px", maxWidth: 520, margin: "0 auto", width: "100%" },
  card: {
    background: "#0a2e2a",
    borderRadius: 12,
    padding: "20px",
    border: "1px solid #194B46",
    boxShadow: "0 4px 24px rgba(0,0,0,0.3)",
  },
  cardTitle: {
    margin: "0 0 6px",
    fontSize: 18,
    color: "#CFF4D2",
    fontWeight: 700,
    letterSpacing: 0.2,
  },
  hint: { fontSize: 13, color: "#BFCDCC", margin: "0 0 16px", lineHeight: 1.6 },
  captureBtn: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    padding: "24px 12px",
    background: "#002521",
    border: "1px dashed #84C4C0",
    borderRadius: 10,
    color: "#84C4C0",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "background 0.2s, border-color 0.2s",
  },
  divider: {
    textAlign: "center",
    color: "#BFCDCC",
    fontSize: 12,
    margin: "12px 0",
    opacity: 0.6,
  },
  previewWrap: {
    marginBottom: 14,
    borderRadius: 8,
    overflow: "hidden",
    border: "1px solid #194B46",
    maxHeight: 180,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#002521",
  },
  preview: { maxWidth: "100%", maxHeight: 180, objectFit: "contain" },
  extracting: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 14px",
    background: "#194B46",
    borderRadius: 8,
    marginBottom: 14,
    fontSize: 13,
    color: "#CFF4D2",
  },
  spinner: {
    width: 16,
    height: 16,
    borderRadius: "50%",
    border: "2px solid #002521",
    borderTopColor: "#CFF4D2",
    animation: "spin 0.8s linear infinite",
    flexShrink: 0,
  },
  fieldGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "12px",
  },
  fieldGroup: { display: "flex", flexDirection: "column", gap: 4 },
  label: {
    fontSize: 10,
    color: "#84C4C0",
    textTransform: "uppercase",
    letterSpacing: 1,
    fontWeight: 600,
  },
  input: {
    background: "#002521",
    border: "1px solid #194B46",
    borderRadius: 6,
    color: "#FFFFFF",
    padding: "9px 11px",
    fontSize: 14,
    fontFamily: "inherit",
    outline: "none",
    width: "100%",
    transition: "border-color 0.2s",
  },
  btn: {
    background: "linear-gradient(135deg, #194B46 0%, #0a2e2a 100%)",
    color: "#CFF4D2",
    border: "1px solid #84C4C0",
    borderRadius: 8,
    padding: "12px 18px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
    letterSpacing: 0.3,
    transition: "opacity 0.2s",
  },
  sheetLink: {
    display: "block",
    textAlign: "center",
    marginTop: 14,
    color: "#84C4C0",
    fontSize: 13,
    textDecoration: "none",
  },
  link: { color: "#84C4C0" },
  toast: {
    position: "fixed",
    top: 16,
    left: "50%",
    transform: "translateX(-50%)",
    color: "#FFFFFF",
    padding: "10px 20px",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
    zIndex: 9999,
    boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
    whiteSpace: "nowrap",
    maxWidth: "90vw",
    overflow: "hidden",
    textOverflow: "ellipsis",
    animation: "fadeIn 0.2s ease",
  },
  modal: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,37,33,0.85)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9000,
    padding: 20,
  },
  modalBox: {
    background: "#0a2e2a",
    borderRadius: 12,
    padding: 24,
    maxWidth: 420,
    width: "100%",
    border: "1px solid #194B46",
    boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
  },
  modalTitle: { margin: "0 0 10px", color: "#CFF4D2", fontSize: 17, fontWeight: 700 },
  modalText: { fontSize: 13, color: "#BFCDCC", lineHeight: 1.6, marginBottom: 14 },
  checklist: {
    marginTop: 20,
    padding: 16,
    background: "#002521",
    borderRadius: 8,
    fontSize: 13,
    lineHeight: 1.8,
    border: "1px solid #194B46",
  },
};
