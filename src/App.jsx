import { useState, useRef, useCallback } from "react";

// ── Helpers ──────────────────────────────────────────────────────────────────

const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";

// Replace this with your Cloudflare Worker URL after deploying the proxy
const PROXY_URL = "https://billing-capture.oscar-137.workers.dev/";

async function extractLabelData(base64Image, mediaType) {
  const response = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64Image },
            },
            {
              type: "text",
              text: `You are a medical administrative assistant. Extract all available patient information from this patient label image.
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
No markdown, no explanation, just the JSON object. Report the name in the format Surname, First name. The insurer will follow the letters PVT and the Insurance number is the string of characters immediately following that. Convert the address from all capitals to sentence case. The birthdate will follow the letters DOB.`,
            },
          ],
        },
      ],
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `API error ${response.status}`);
  const text = data.content?.find((b) => b.type === "text")?.text || "{}";
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return {};
  }
}

async function appendToSheet(sheetId, accessToken, rowData) {
  const values = [
    [
      rowData.timestamp,
      rowData.patientName ?? "",
      rowData.dob ?? "",
      rowData.medicareNumber ?? "",
      rowData.medicareIRN ?? "",
      rowData.medicareExpiry ?? "",
      rowData.address ?? "",
      rowData.insurer ?? "",
      rowData.insuranceNumber ?? "",
      rowData.referrer ?? "",
      rowData.gp ?? "",
      rowData.serviceCode,
      rowData.dateOfService,
    ],
  ];
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A1:append?valueInputOption=USER_ENTERED`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values }),
    }
  );
  return res.ok;
}

async function createSheet(accessToken) {
  const res = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: { title: "Patient Billing Records" },
      sheets: [
        {
          properties: { title: "Sheet1" },
          data: [
            {
              startRow: 0,
              startColumn: 0,
              rowData: [
                {
                  values: [
                    "Timestamp",
                    "Patient Name",
                    "DOB",
                    "Medicare Number",
                    "Medicare IRN",
                    "Medicare Expiry",
                    "Address",
                    "Insurer",
                    "Insurance Number",
                    "Referrer",
                    "GP",
                    "Service Code",
                    "Date of Service",
                  ].map((v) => ({ userEnteredValue: { stringValue: v } })),
                },
              ],
            },
          ],
        },
      ],
    }),
  });
  const data = await res.json();
  return data.spreadsheetId;
}

async function getSheetData(sheetId, accessToken) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  return data.values || [];
}

async function sendEmail(accessToken, toEmail, subject, body) {
  const message = [`To: ${toEmail}`, `Subject: ${subject}`, "", body].join("\n");
  const encoded = btoa(unescape(encodeURIComponent(message)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: encoded }),
  });
  return res.ok;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const base64 = result.split(",")[1];
      resolve({ base64, mediaType: file.type });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Google OAuth ─────────────────────────────────────────────────────────────

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

function useGoogleAuth() {
  const [accessToken, setAccessToken] = useState(null);
  const [userEmail, setUserEmail] = useState(null);
  const [clientId, setClientId] = useState("");
  const [showClientIdInput, setShowClientIdInput] = useState(false);

  const signIn = useCallback(() => {
    if (!clientId.trim()) {
      setShowClientIdInput(true);
      return;
    }
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: window.location.origin + window.location.pathname,
      response_type: "token",
      scope: SCOPES,
      include_granted_scopes: "true",
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
      fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => r.json())
        .then((d) => setUserEmail(d.email));
    }
  }, []);

  return { accessToken, userEmail, clientId, setClientId, showClientIdInput, setShowClientIdInput, signIn, parseToken };
}

// ── Main App ──────────────────────────────────────────────────────────────────

const EMPTY_FIELDS = {
  patientName: "",
  dob: "",
  medicareNumber: "",
  medicareIRN: "",
  medicareExpiry: "",
  address: "",
  insurer: "",
  insuranceNumber: "",
  referrer: "",
  gp: "",
  serviceCode: "",
  dateOfService: new Date().toISOString().split("T")[0],
};

const FIELD_LABELS = {
  patientName: "Patient Name",
  dob: "Date of Birth",
  medicareNumber: "Medicare Number",
  medicareIRN: "Medicare IRN",
  medicareExpiry: "Medicare Expiry",
  address: "Address",
  insurer: "Insurer",
  insuranceNumber: "Insurance Number",
  referrer: "Referrer",
  gp: "GP",
  serviceCode: "Service Code",
  dateOfService: "Date of Service",
};

export default function App() {
  const auth = useGoogleAuth();
  const [step, setStep] = useState("capture");
  const [imagePreview, setImagePreview] = useState(null);
  const [fields, setFields] = useState(EMPTY_FIELDS);
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [sheetId, setSheetId] = useState(() => localStorage.getItem("sheetId") || "");
  const [reportFilter, setReportFilter] = useState({ serviceCode: "", dateFrom: "", dateTo: "" });
  const [reportLoading, setReportLoading] = useState(false);
  const fileInputRef = useRef();
  const cameraInputRef = useRef();

  useState(() => { auth.parseToken(); });

  const showToast = (msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const handleFile = async (file) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setImagePreview(url);
    setExtracting(true);
    setStep("review");
    try {
      const { base64, mediaType } = await fileToBase64(file);
      const extracted = await extractLabelData(base64, mediaType);
      setFields((f) => ({
        ...f,
        ...Object.fromEntries(
          Object.entries(extracted).map(([k, v]) => [k, v ?? ""])
        ),
      }));
    } catch (e) {
      console.error("Extraction error:", e);
      showToast(`Extraction failed: ${e?.message || "check console for details"}`, "error");
    } finally {
      setExtracting(false);
    }
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
        localStorage.setItem("sheetId", sid);
      }
      const ok = await appendToSheet(sid, auth.accessToken, {
        ...fields,
        timestamp: new Date().toISOString(),
      });
      if (ok) {
        showToast("Record saved to Google Sheets ✓");
        setStep("capture");
        setFields(EMPTY_FIELDS);
        setImagePreview(null);
      } else {
        showToast("Save failed — check sheet permissions.", "error");
      }
    } catch (e) {
      showToast("Error: " + e.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleReport = async () => {
    if (!auth.accessToken || !auth.userEmail) { showToast("Please sign in first.", "error"); return; }
    if (!sheetId) { showToast("No sheet found — save a record first.", "error"); return; }
    setReportLoading(true);
    try {
      const rows = await getSheetData(sheetId, auth.accessToken);
      if (rows.length < 2) { showToast("No data in sheet yet.", "error"); setReportLoading(false); return; }
      const [header, ...data] = rows;
      const idx = Object.fromEntries(header.map((h, i) => [h, i]));

      let filtered = data;
      if (reportFilter.serviceCode)
        filtered = filtered.filter((r) =>
          (r[idx["Service Code"]] || "").toLowerCase().includes(reportFilter.serviceCode.toLowerCase())
        );
      if (reportFilter.dateFrom)
        filtered = filtered.filter((r) => (r[idx["Date of Service"]] || "") >= reportFilter.dateFrom);
      if (reportFilter.dateTo)
        filtered = filtered.filter((r) => (r[idx["Date of Service"]] || "") <= reportFilter.dateTo);

      const grouped = {};
      for (const r of filtered) {
        const name = r[idx["Patient Name"]] || "Unknown";
        if (!grouped[name]) grouped[name] = [];
        grouped[name].push(r);
      }

      let body = `Patient Billing Report\nGenerated: ${new Date().toLocaleString("en-AU")}\n`;
      if (reportFilter.serviceCode) body += `Service Code Filter: ${reportFilter.serviceCode}\n`;
      if (reportFilter.dateFrom) body += `From: ${reportFilter.dateFrom}\n`;
      if (reportFilter.dateTo) body += `To: ${reportFilter.dateTo}\n`;
      body += `\n${"─".repeat(60)}\n\n`;

      for (const [patient, records] of Object.entries(grouped)) {
        body += `PATIENT: ${patient}\n`;
        body += `  DOB: ${records[0][idx["DOB"]] || "—"}  |  Medicare: ${records[0][idx["Medicare Number"]] || "—"}  IRN: ${records[0][idx["Medicare IRN"]] || "—"}  Exp: ${records[0][idx["Medicare Expiry"]] || "—"}\n`;
        body += `  GP: ${records[0][idx["GP"]] || "—"}  |  Referrer: ${records[0][idx["Referrer"]] || "—"}\n`;
        body += `  Insurer: ${records[0][idx["Insurer"]] || "—"}  |  Insurance #: ${records[0][idx["Insurance Number"]] || "—"}\n`;
        body += `\n  Services:\n`;
        for (const r of records) {
          body += `    • ${r[idx["Date of Service"]] || "?"}  –  ${r[idx["Service Code"]] || "?"}\n`;
        }
        body += `\n${"─".repeat(60)}\n\n`;
      }

      body += `Total records: ${filtered.length} across ${Object.keys(grouped).length} patient(s)\n`;
      body += `\nView full sheet: https://docs.google.com/spreadsheets/d/${sheetId}`;

      const subject = `Billing Report${reportFilter.serviceCode ? ` – ${reportFilter.serviceCode}` : ""} – ${new Date().toLocaleDateString("en-AU")}`;
      const ok = await sendEmail(auth.accessToken, auth.userEmail, subject, body);
      if (ok) showToast(`Report emailed to ${auth.userEmail} ✓`);
      else showToast("Email failed — check Gmail permissions.", "error");
    } catch (e) {
      showToast("Error: " + e.message, "error");
    } finally {
      setReportLoading(false);
    }
  };

  return (
    <div style={styles.root}>
      {toast && (
        <div style={{ ...styles.toast, background: toast.type === "error" ? "#c0392b" : "#1a6b3c" }}>
          {toast.msg}
        </div>
      )}

      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={styles.logo}>⚕</span>
          <span style={styles.appName}>BillingCapture</span>
        </div>
        <div style={styles.headerRight}>
          {auth.accessToken ? (
            <span style={styles.signedIn}>● {auth.userEmail || "Signed in"}</span>
          ) : (
            <button style={styles.signInBtn} onClick={auth.signIn}>
              Sign in with Google
            </button>
          )}
        </div>
      </header>

      {auth.showClientIdInput && (
        <div style={styles.modal}>
          <div style={styles.modalBox}>
            <h3 style={styles.modalTitle}>Google API Setup</h3>
            <p style={styles.modalText}>
              Enter your Google OAuth Client ID. You need to create one at{" "}
              <a href="https://console.cloud.google.com" target="_blank" rel="noreferrer" style={styles.link}>
                console.cloud.google.com
              </a>{" "}
              with Sheets, Gmail, and OAuth APIs enabled, and this page's URL as an authorised redirect URI.
            </p>
            <input
              style={styles.input}
              placeholder="xxxx.apps.googleusercontent.com"
              value={auth.clientId}
              onChange={(e) => auth.setClientId(e.target.value)}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button style={styles.btn} onClick={() => { auth.setShowClientIdInput(false); auth.signIn(); }}>
                Connect
              </button>
              <button style={{ ...styles.btn, background: "#555" }} onClick={() => auth.setShowClientIdInput(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <nav style={styles.nav}>
        {["capture", "review", "report", "settings"].map((t) => (
          <button
            key={t}
            style={{ ...styles.navBtn, ...(step === t ? styles.navBtnActive : {}) }}
            onClick={() => setStep(t)}
          >
            {{ capture: "📷 Capture", review: "✏️ Review", report: "📊 Report", settings: "⚙️ Settings" }[t]}
          </button>
        ))}
      </nav>

      <main style={styles.main}>
        {step === "capture" && (
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Scan Patient Label</h2>
            <p style={styles.hint}>Take a photo or upload an image of the patient label. Data will be extracted automatically.</p>
            <div style={styles.captureButtons}>
              <button style={styles.captureBtn} onClick={() => cameraInputRef.current?.click()}>
                <span style={styles.captureBtnIcon}>📷</span>
                <span>Take Photo</span>
              </button>
              <button style={styles.captureBtn} onClick={() => fileInputRef.current?.click()}>
                <span style={styles.captureBtnIcon}>🖼️</span>
                <span>Upload Image</span>
              </button>
            </div>
            <input ref={cameraInputRef} type="file" accept="image/*" capture="environment"
              style={{ display: "none" }} onChange={(e) => handleFile(e.target.files[0])} />
            <input ref={fileInputRef} type="file" accept="image/*"
              style={{ display: "none" }} onChange={(e) => handleFile(e.target.files[0])} />
            <div style={styles.orDivider}><span>or</span></div>
            <button style={{ ...styles.btn, width: "100%" }} onClick={() => setStep("review")}>
              Enter Manually
            </button>
          </div>
        )}

        {step === "review" && (
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Review &amp; Save</h2>
            {imagePreview && (
              <div style={styles.previewWrap}>
                <img src={imagePreview} alt="Patient label" style={styles.preview} />
              </div>
            )}
            {extracting && (
              <div style={styles.extracting}>
                <div style={styles.spinner} />
                <span>Extracting data from label…</span>
              </div>
            )}
            <div style={styles.fieldGrid}>
              {Object.entries(FIELD_LABELS).map(([key, label]) => (
                <div key={key} style={key === "address" ? { ...styles.fieldGroup, gridColumn: "1 / -1" } : styles.fieldGroup}>
                  <label style={styles.label}>{label}</label>
                  <input
                    style={{
                      ...styles.input,
                      borderColor: key === "serviceCode" && !fields[key] ? "#c0392b" : undefined,
                    }}
                    type={key === "dateOfService" || key === "dob" ? "date" : "text"}
                    value={fields[key]}
                    onChange={(e) => setFields((f) => ({ ...f, [key]: e.target.value }))}
                    placeholder={key === "serviceCode" ? "Required" : ""}
                  />
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button style={{ ...styles.btn, background: "#555", flex: 1 }} onClick={() => { setStep("capture"); setImagePreview(null); setFields(EMPTY_FIELDS); }}>
                ← Back
              </button>
              <button style={{ ...styles.btn, flex: 2 }} onClick={handleSave} disabled={saving || extracting}>
                {saving ? "Saving…" : "Save to Google Sheets"}
              </button>
            </div>
          </div>
        )}

        {step === "report" && (
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Email Report</h2>
            <p style={styles.hint}>Filter records and email a summary grouped by patient to {auth.userEmail || "your Gmail"}.</p>
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Service Code (partial match, optional)</label>
              <input style={styles.input} value={reportFilter.serviceCode}
                onChange={(e) => setReportFilter((f) => ({ ...f, serviceCode: e.target.value }))}
                placeholder="e.g. 30088" />
            </div>
            <div style={styles.fieldGrid}>
              <div style={styles.fieldGroup}>
                <label style={styles.label}>Date of Service — From</label>
                <input style={styles.input} type="date" value={reportFilter.dateFrom}
                  onChange={(e) => setReportFilter((f) => ({ ...f, dateFrom: e.target.value }))} />
              </div>
              <div style={styles.fieldGroup}>
                <label style={styles.label}>Date of Service — To</label>
                <input style={styles.input} type="date" value={reportFilter.dateTo}
                  onChange={(e) => setReportFilter((f) => ({ ...f, dateTo: e.target.value }))} />
              </div>
            </div>
            <button style={{ ...styles.btn, width: "100%", marginTop: 16 }} onClick={handleReport} disabled={reportLoading || !auth.accessToken}>
              {reportLoading ? "Generating…" : "📧 Send Report to My Email"}
            </button>
            {sheetId && (
              <a href={`https://docs.google.com/spreadsheets/d/${sheetId}`} target="_blank" rel="noreferrer" style={styles.sheetLink}>
                View full spreadsheet ↗
              </a>
            )}
          </div>
        )}

        {step === "settings" && (
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Settings</h2>
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Google OAuth Client ID</label>
              <input style={styles.input} value={auth.clientId}
                onChange={(e) => auth.setClientId(e.target.value)}
                placeholder="xxxx.apps.googleusercontent.com" />
              <p style={styles.hint}>
                Create at{" "}
                <a href="https://console.cloud.google.com" target="_blank" rel="noreferrer" style={styles.link}>
                  console.cloud.google.com
                </a>
                . Enable Google Sheets API, Gmail API, and Google OAuth. Add this page's URL as a redirect URI.
              </p>
            </div>
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Google Sheet ID (auto-created on first save)</label>
              <input style={styles.input} value={sheetId}
                onChange={(e) => { setSheetId(e.target.value); localStorage.setItem("sheetId", e.target.value); }}
                placeholder="Paste existing sheet ID to reuse" />
            </div>
            <button style={styles.btn} onClick={auth.signIn}>
              {auth.accessToken ? "Re-authenticate Google" : "Connect Google Account"}
            </button>
            <div style={{ marginTop: 24, padding: 16, background: "#1a1a2e", borderRadius: 10, fontSize: 13, color: "#aaa", lineHeight: 1.7 }}>
              <strong style={{ color: "#ddd" }}>Setup checklist:</strong>
              <ol style={{ paddingLeft: 18, margin: "8px 0 0" }}>
                <li>Go to Google Cloud Console → New Project</li>
                <li>Enable <em>Google Sheets API</em> and <em>Gmail API</em></li>
                <li>OAuth consent screen → External → add your Gmail as test user</li>
                <li>Credentials → OAuth 2.0 Client ID → Web application</li>
                <li>Add this page URL to Authorised redirect URIs</li>
                <li>Paste Client ID above → Save → Sign In</li>
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
    background: "#0d0d1a",
    color: "#e8e8f0",
    fontFamily: "'Georgia', 'Times New Roman', serif",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 18px",
    background: "#13132b",
    borderBottom: "1px solid #2a2a4a",
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 10 },
  logo: { fontSize: 22 },
  appName: { fontSize: 17, fontWeight: "bold", letterSpacing: 0.5, color: "#c8d8ff" },
  headerRight: {},
  signedIn: { fontSize: 12, color: "#7aff9e" },
  signInBtn: {
    background: "#2a3aff",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "7px 14px",
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  nav: {
    display: "flex",
    background: "#13132b",
    borderBottom: "1px solid #2a2a4a",
    overflowX: "auto",
  },
  navBtn: {
    flex: 1,
    padding: "10px 4px",
    background: "none",
    border: "none",
    color: "#888",
    fontSize: 12,
    cursor: "pointer",
    borderBottom: "2px solid transparent",
    whiteSpace: "nowrap",
    fontFamily: "inherit",
    transition: "color 0.2s",
  },
  navBtnActive: {
    color: "#c8d8ff",
    borderBottomColor: "#2a3aff",
  },
  main: { flex: 1, padding: "16px", maxWidth: 520, margin: "0 auto", width: "100%" },
  card: {
    background: "#15152e",
    borderRadius: 16,
    padding: "20px",
    border: "1px solid #2a2a4a",
  },
  cardTitle: {
    margin: "0 0 6px",
    fontSize: 20,
    color: "#c8d8ff",
    fontWeight: "bold",
  },
  hint: { fontSize: 13, color: "#888", margin: "0 0 16px", lineHeight: 1.5 },
  captureButtons: { display: "flex", gap: 12, marginBottom: 20 },
  captureBtn: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    padding: "24px 12px",
    background: "#1e1e3f",
    border: "1px dashed #3a3a6a",
    borderRadius: 14,
    color: "#c8d8ff",
    fontSize: 14,
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "background 0.2s",
  },
  captureBtnIcon: { fontSize: 32 },
  orDivider: {
    textAlign: "center",
    color: "#555",
    fontSize: 13,
    margin: "12px 0",
    position: "relative",
  },
  previewWrap: {
    marginBottom: 14,
    borderRadius: 10,
    overflow: "hidden",
    border: "1px solid #2a2a4a",
    maxHeight: 180,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#0d0d1a",
  },
  preview: { maxWidth: "100%", maxHeight: 180, objectFit: "contain" },
  extracting: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 14px",
    background: "#1a1a3a",
    borderRadius: 8,
    marginBottom: 14,
    fontSize: 13,
    color: "#aac",
  },
  spinner: {
    width: 16,
    height: 16,
    borderRadius: "50%",
    border: "2px solid #4040aa",
    borderTopColor: "#a0a0ff",
    animation: "spin 0.8s linear infinite",
  },
  fieldGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "12px 12px",
  },
  fieldGroup: { display: "flex", flexDirection: "column", gap: 4 },
  label: { fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 0.5 },
  input: {
    background: "#1e1e3f",
    border: "1px solid #3a3a6a",
    borderRadius: 8,
    color: "#e8e8f0",
    padding: "9px 11px",
    fontSize: 14,
    fontFamily: "inherit",
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
  },
  btn: {
    background: "#2a3aff",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "12px 18px",
    fontSize: 15,
    cursor: "pointer",
    fontFamily: "inherit",
    fontWeight: "bold",
  },
  sheetLink: {
    display: "block",
    textAlign: "center",
    marginTop: 14,
    color: "#7a9fff",
    fontSize: 13,
    textDecoration: "none",
  },
  link: { color: "#7a9fff" },
  toast: {
    position: "fixed",
    top: 16,
    left: "50%",
    transform: "translateX(-50%)",
    color: "#fff",
    padding: "10px 20px",
    borderRadius: 10,
    fontSize: 14,
    zIndex: 9999,
    boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
    whiteSpace: "nowrap",
  },
  modal: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.7)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9000,
    padding: 20,
  },
  modalBox: {
    background: "#15152e",
    borderRadius: 16,
    padding: 24,
    maxWidth: 420,
    width: "100%",
    border: "1px solid #3a3a6a",
  },
  modalTitle: { margin: "0 0 10px", color: "#c8d8ff", fontSize: 18 },
  modalText: { fontSize: 13, color: "#aaa", lineHeight: 1.6, marginBottom: 14 },
};

// Inject keyframes
const style = document.createElement("style");
style.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
document.head.appendChild(style);
