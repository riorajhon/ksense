const API_KEY = "ak_52ceff5cb293e68556eaac984e9c73c6cdab7144c4f49390";
const BASE_URL = "https://assessment.ksensetech.com/api/patients"; // Correct endpoint

/**
 * Fetch with retry and exponential backoff
 */
async function fetchWithRetry(url, options, retries = 5, backoff = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);

      if (res.status === 429) {
        console.warn("Rate limit hit. Retrying...");
        await new Promise(r => setTimeout(r, backoff));
        backoff *= 2;
        continue;
      }

      if (res.status >= 500 && res.status < 600) {
        console.warn(`Server error ${res.status}. Retrying...`);
        await new Promise(r => setTimeout(r, backoff));
        backoff *= 2;
        continue;
      }

      if (res.status === 404) {
        throw new Error("404 Not Found – check the endpoint URL");
      }

      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      return await res.json();

    } catch (err) {
      console.warn(`Attempt ${i + 1} failed: ${err.message}`);
      await new Promise(r => setTimeout(r, backoff));
      backoff *= 2;
    }
  }
  throw new Error("Max retries exceeded");
}

/**
 * Fetch all patients with pagination
 */
async function fetchAllPatients() {
  let page = 1;
  const allPatients = [];
  let hasNext = true;

  while (hasNext) {
    const url = `${BASE_URL}?page=${page}&limit=20`;
    const data = await fetchWithRetry(url, { headers: { "x-api-key": API_KEY } });
    allPatients.push(...data.data);
    hasNext = data.pagination.hasNext;
    page++;
  }

  return allPatients;
}

/**
 * Safe number parsing
 */
function parseNumber(value) {
  const n = parseFloat(value);
  return isNaN(n) ? null : n;
}

/**
 * Risk scoring functions
 */
function getBloodPressureScore(bp) {
  if (!bp || !bp.includes("/")) return 0;
  const [systolic, diastolic] = bp.split("/").map(parseNumber);
  if (systolic === null || diastolic === null) return 0;

  if (systolic >= 140 || diastolic >= 90) return 4;
  if (systolic >= 130 || diastolic >= 80) return 3;
  if (systolic >= 120 && diastolic < 80) return 2;
  if (systolic < 120 && diastolic < 80) return 1;
  return 0;
}

function getTemperatureScore(temp) {
  const t = parseNumber(temp);
  if (t === null) return 0;
  if (t <= 99.5) return 0;
  if (t <= 100.9) return 1;
  if (t >= 101) return 2;
  return 0;
}

function getAgeScore(age) {
  const a = parseNumber(age);
  if (a === null) return 0;
  if (a > 65) return 2;
  if (a >= 40) return 1;
  if (a < 40) return 1;
  return 0;
}

/**
 * Analyze patients and generate alerts
 */
function analyzePatients(patients) {
  const highRiskPatients = [];
  const feverPatients = [];
  const dataQualityIssues = [];

  patients.forEach(p => {
    const bpScore = getBloodPressureScore(p.blood_pressure);
    const tempScore = getTemperatureScore(p.temperature);
    const ageScore = getAgeScore(p.age);
    const totalScore = bpScore + tempScore + ageScore;

    if (totalScore >= 4) highRiskPatients.push(p.patient_id);
    if (parseNumber(p.temperature) >= 99.6) feverPatients.push(p.patient_id);
    if (bpScore === 0 || tempScore === 0 || ageScore === 0) dataQualityIssues.push(p.patient_id);
  });

  return { highRiskPatients, feverPatients, dataQualityIssues };
}

/**
 * Submit results to assessment API
 */
async function submitResults(alerts, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch('https://assessment.ksensetech.com/api/submit-assessment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY
        },
        body: JSON.stringify({
          high_risk_patients: alerts.highRiskPatients,
          fever_patients: alerts.feverPatients,
          data_quality_issues: alerts.dataQualityIssues
        })
      });

      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const data = await res.json();
      console.log('Submission Result:', data);
      return;

    } catch (err) {
      console.warn(`Submission attempt ${i + 1} failed: ${err.message}`);
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }

  throw new Error("Failed to submit after multiple attempts");
}

/**
 * Main execution
 */
(async () => {
  try {
    const patients = await fetchAllPatients();
    console.log(`Fetched ${patients.length} patients`);
    
    const alerts = analyzePatients(patients);
    console.log("Prepared alerts:", alerts);

    await submitResults(alerts);
    console.log("Assessment submission completed successfully!");
  } catch (err) {
    console.error("Error during assessment:", err);
  }
})();
