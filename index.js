const API_KEY = "ak_52ceff5cb293e68556eaac984e9c73c6cdab7144c4f49390";
const BASE_URL = "https://assessment.ksensetech.com/api/patients";

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

      if (res.status === 404) throw new Error("404 Not Found – check endpoint URL");
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
 * Fetch all patients safely with logging
 */
async function fetchAllPatients() {
  let page = 1;
  const allPatients = [];
  let hasNext = true;

  while (hasNext) {
    const url = `${BASE_URL}?page=${page}&limit=20`;
    const data = await fetchWithRetry(url, { headers: { "x-api-key": API_KEY } });

    console.log("Raw API response for page", page, ":", data);

    if (!data || !Array.isArray(data.data)) {
      console.warn("Skipping page", page, "– data is not an array");
      hasNext = false;
      continue;
    }

    allPatients.push(...data.data);

    hasNext = data.pagination && data.pagination.hasNext ? data.pagination.hasNext : false;
    page++;
  }

  return allPatients;
}

/**
 * Risk scoring functions
 */
function getBloodPressureScore(bp) {
  if (!bp || !bp.includes("/")) return 0;
  const [systolicStr, diastolicStr] = bp.split("/");
  const systolic = parseInt(systolicStr, 10);
  const diastolic = parseInt(diastolicStr, 10);

  if (isNaN(systolic) || isNaN(diastolic)) return 0;

  if (systolic >= 140 || diastolic >= 90) return 4;
  if (systolic >= 130 || diastolic >= 80) return 3;
  if (systolic >= 120 && diastolic < 80) return 2;
  if (systolic < 120 && diastolic < 80) return 1;

  return 0;
}

function getTemperatureScore(temp) {
  const t = parseFloat(temp);
  if (isNaN(t)) return 0;
  if (t <= 99.5) return 0;
  if (t <= 100.9) return 1;
  if (t >= 101) return 2;
  return 0;
}

function getAgeScore(age) {
  const a = parseInt(age, 10);
  if (isNaN(a)) return 0;
  if (a > 65) return 2;
  return 1;
}

/**
 * Analyze patients and generate alerts
 */
function analyzePatients(patients) {
  const highRiskPatients = [];
  const feverPatients = [];
  const dataQualityIssues = [];

  patients.forEach(p => {
    // Strict validation for each metric
    const validBP = p.blood_pressure && p.blood_pressure.includes("/") &&
                    !isNaN(parseInt(p.blood_pressure.split("/")[0], 10)) &&
                    !isNaN(parseInt(p.blood_pressure.split("/")[1], 10));
    const validTemp = !isNaN(parseFloat(p.temperature));
    const validAge = !isNaN(parseInt(p.age, 10));

    // Compute scores only if values are valid
    const bpScore = validBP ? getBloodPressureScore(p.blood_pressure) : 0;
    const tempScore = validTemp ? getTemperatureScore(p.temperature) : 0;
    const ageScore = validAge ? getAgeScore(p.age) : 0;
    const totalScore = bpScore + tempScore + ageScore;

    // High-Risk: total score >= 4 AND at least one valid metric exists
    if (totalScore >= 4 && (validBP || validTemp || validAge)) {
      highRiskPatients.push(p.patient_id);
    }

    // Fever: temperature >= 99.6°F
    if (validTemp && parseFloat(p.temperature) >= 99.6) {
      feverPatients.push(p.patient_id);
    }

    // Data-quality: any metric invalid
    if (!validBP || !validTemp || !validAge) {
      dataQualityIssues.push(p.patient_id);
    }
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

    console.log("High-Risk Patients:", alerts.highRiskPatients);
    console.log("Fever Patients:", alerts.feverPatients);
    console.log("Data-Quality Issues:", alerts.dataQualityIssues);

    await submitResults(alerts);
    console.log("Assessment submission completed successfully!");
  } catch (err) {
    console.error("Error during assessment:", err);
  }
})();
