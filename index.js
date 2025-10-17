// index.js
const fetch = require("node-fetch"); // node-fetch@2 (CommonJS compatible)
const API_KEY = "ak_52ceff5cb293e68556eaac984e9c73c6cdab7144c4f49390";
const BASE_URL = "https://assessment.ksensetech.com/api/patients";

/**
 * Safe fetch with retry for 429 / 5xx errors
 */
async function fetchWithRetry(url, options, retries = 5, backoff = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);

      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        console.warn(`Retrying after status ${res.status} (attempt ${i + 1})`);
        await new Promise(r => setTimeout(r, backoff));
        backoff *= 2;
        continue;
      }

      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      return await res.json();
    } catch (err) {
      console.warn(`Attempt ${i + 1} failed: ${err.message}`);
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, backoff));
      backoff *= 2;
    }
  }
}

/**
 * Extract patients safely (handles different API structures)
 */
function extractPatients(data) {
  if (!data) return [];
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.patients)) return data.patients;
  if (Array.isArray(data.result)) return data.result;
  console.warn("⚠️ Unknown API structure:", JSON.stringify(data, null, 2));
  return [];
}

/**
 * Fetch all paginated patients
 */
async function fetchAllPatients() {
  const all = [];
  let page = 1;
  let hasNext = true;

  while (hasNext) {
    const url = `${BASE_URL}?page=${page}&limit=20`;
    const data = await fetchWithRetry(url, { headers: { "x-api-key": API_KEY } });
    const patients = extractPatients(data);

    if (!Array.isArray(patients) || patients.length === 0) break;
    all.push(...patients);

    hasNext = data.pagination?.hasNext ?? patients.length > 0;
    page++;
  }

  return all;
}

/**
 * Risk calculations
 */
function getBloodPressureScore(bp) {
  if (!bp || !bp.includes("/")) return 0;
  const [s, d] = bp.split("/").map(v => parseInt(v.trim(), 10));
  if (isNaN(s) || isNaN(d)) return 0;
  if (s >= 140 || d >= 90) return 4;
  if (s >= 130 || d >= 80) return 3;
  if (s >= 120 && d < 80) return 2;
  if (s < 120 && d < 80) return 1;
  return 0;
}

function getTemperatureScore(t) {
  const temp = parseFloat(t);
  if (isNaN(temp)) return 0;
  if (temp <= 99.5) return 0;
  if (temp <= 100.9) return 1;
  if (temp >= 101) return 2;
  return 0;
}

function getAgeScore(age) {
  const a = parseInt(age, 10);
  if (isNaN(a)) return 0;
  if (a > 65) return 2;
  return 1;
}

/**
 * Analyze and classify patients
 */
function analyzePatients(patients) {
  const highRisk = [];
  const fever = [];
  const dataIssues = [];

  for (const p of patients) {
    const id = p.patient_id?.toString().trim();
    if (!id) continue;

    const validBP = typeof p.blood_pressure === "string" && p.blood_pressure.includes("/") &&
                    !isNaN(parseInt(p.blood_pressure.split("/")[0])) &&
                    !isNaN(parseInt(p.blood_pressure.split("/")[1]));
    const validTemp = !isNaN(parseFloat(p.temperature));
    const validAge = !isNaN(parseInt(p.age));

    const bpScore = getBloodPressureScore(p.blood_pressure);
    const tempScore = getTemperatureScore(p.temperature);
    const ageScore = getAgeScore(p.age);
    const total = bpScore + tempScore + ageScore;

    if (total >= 4 && validBP && validAge) highRisk.push(id);
    if (validTemp && parseFloat(p.temperature) >= 99.6) fever.push(id);
    if (!validBP || !validTemp || !validAge) dataIssues.push(id);
  }

  // Deduplicate arrays
  return {
    highRiskPatients: [...new Set(highRisk)],
    feverPatients: [...new Set(fever)],
    dataQualityIssues: [...new Set(dataIssues)]
  };
}

/**
 * Submit results with retry and diagnostics
 */
async function submitResults(alerts) {
  const payload = {
    high_risk_patients: alerts.highRiskPatients,
    fever_patients: alerts.feverPatients,
    data_quality_issues: alerts.dataQualityIssues
  };

  console.log("🟦 Submitting payload:", JSON.stringify(payload, null, 2));

  for (let i = 0; i < 3; i++) {
    const res = await fetch("https://assessment.ksensetech.com/api/submit-assessment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY
      },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      const result = await res.json();
      console.log("✅ Submission successful:\n", JSON.stringify(result, null, 2));
      return;
    }

    const text = await res.text();
    console.error(`❌ Submission failed (status ${res.status}) attempt ${i + 1}\nResponse: ${text}`);
    if (res.status >= 500 || res.status === 429) {
      console.warn("Retrying in 2s...");
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    break; // stop retrying on 4xx errors
  }

  throw new Error("Failed to submit after multiple attempts.");
}

/**
 * MAIN
 */
(async () => {
  try {
    console.log("🔄 Fetching all patients...");
    const patients = await fetchAllPatients();
    console.log(`✅ Total patients fetched: ${patients.length}`);

    if (patients.length === 0) throw new Error("No patients fetched.");

    const alerts = analyzePatients(patients);

    console.log(`📊 High-Risk: ${alerts.highRiskPatients.length}`);
    console.log(`🌡️ Fever: ${alerts.feverPatients.length}`);
    console.log(`⚠️ Data Issues: ${alerts.dataQualityIssues.length}`);

    if (
      alerts.highRiskPatients.length === 0 &&
      alerts.feverPatients.length === 0 &&
      alerts.dataQualityIssues.length === 0
    ) {
      throw new Error("All alert arrays are empty. Not submitting.");
    }

    await submitResults(alerts);
    console.log("🎉 Assessment completed successfully!");
  } catch (err) {
    console.error("🚨 Error during assessment:", err);
  }
})();
