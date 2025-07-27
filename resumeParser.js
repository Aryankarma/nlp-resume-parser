const fs = require("fs");
const pdf = require("pdf-parse");
const nlp = require("compromise");
const chrono = require("chrono-node");
const fuzz = require("fuzzball");

// Heuristically identify sections (fuzzy)
const sectionMatch = (line, section) =>
  fuzz.token_set_ratio(line.toLowerCase(), section.toLowerCase()) > 80;

const extractSection = (lines, sectionKeywords) => {
  let found = false;
  const section = [];

  for (let i = 0; i < lines.length; i++) {
    if (!found) {
      for (const keyword of sectionKeywords) {
        if (sectionMatch(lines[i], keyword)) {
          found = true;
          break;
        }
      }
    } else {
      const isNewSection = sectionKeywords.some(k => sectionMatch(lines[i], k));
      if (isNewSection || lines[i].length === 0) break;
      section.push(lines[i]);
    }
  }

  return section;
};



// Extract dates using chrono
const extractDates = (text) => {
  const results = chrono.parse(text);
  if (results.length >= 2) {
    return {
      startDate: results[0].start?.date().toISOString().split("T")[0],
      endDate: results[1].start?.date().toISOString().split("T")[0],
    };
  }
  if (results.length === 1) {
    return {
      startDate: results[0].start?.date().toISOString().split("T")[0],
      endDate: "",
    };
  }
  return { startDate: "", endDate: "" };
};

// Smart parsing logic
const parseResume = (text) => {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const joinedText = lines.join(" ");
  const doc = nlp(text);

  const resume = {
    name: doc.people().first().text() || lines[0],
    email: text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g)?.[0] || "",
    phone: text.match(/(?:\+?\d{1,3}[-\s]?)?\d{10}/)?.[0] || "",
    address: "", // Could try extracting based on known cities/states list
    summary: extractSection(lines, ["summary", "profile", "about"])[0] || "",
    linkedin: text.match(/https?:\/\/(www\.)?linkedin\.com\/[^\s)]+/g)?.[0] || "",
    jobRole: [],

    
    education: (() => {
  const sectionLines = extractSection(lines, ["education", "academics"]);
  const groupedEntries = [];

  // Group lines into entries based on patterns or spacing
  let buffer = [];
  for (const line of sectionLines) {
    if (line.trim() === "") continue;
    if (/\d{4}/.test(line) || /CGPA|GPA|Score/i.test(line)) {
      buffer.push(line);
      groupedEntries.push(buffer.join(" "));
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  if (buffer.length) groupedEntries.push(buffer.join(" "));

  // Parse structured data
  return groupedEntries.map((entry) => {
    const { startDate, endDate } = extractDates(entry);

    const degreeMatch = entry.match(
      /(Bachelor|Master|B\.?Tech|M\.?Tech|B\.?Sc|M\.?Sc|B\.?A|M\.?A|BBA|MBA|LLB|LLM|Ph\.?D|Diploma|PGDM)/i
    );

    const fieldMatch = entry.match(
      /(Law|Computer Science|Engineering|Economics|Physics|Mathematics|Commerce|Arts|Political Science|Business|Finance|Management|English|History|Civil|Mechanical|Electronics|Cybersecurity)/i
    );

    const institution = entry.split(/(?:Bachelor|Master|B\.?Tech|M\.?Tech|B\.?Sc|M\.?Sc|B\.?A|M\.?A|BBA|MBA|LLB|LLM|Ph\.?D|Diploma|PGDM)/i)[0]?.trim();

    return {
      institution: institution || entry.trim(),
      degree: degreeMatch ? degreeMatch[0].replace(/\./g, "").trim() : "",
      fieldOfStudy: fieldMatch ? fieldMatch[0].trim() : "",
      startDate,
      endDate,
    };
  });
})(),


    workExperience: extractSection(lines, ["experience", "work", "employment"]).map((line) => {
      const { startDate, endDate } = extractDates(line);
      return {
        company: line,
        position: "",
        startDate,
        endDate,
        description: line,
      };
    }),

    skills: (() => {
      const skillMatch = extractSection(lines, ["skills", "technologies"]).join(" ");
      return skillMatch
        .split(/[,•|]+/)
        .map(s => s.trim())
        .filter(Boolean)
        .filter(s => s.length < 30);
    })(),

    projects: extractSection(lines, ["projects", "personal projects"]).map((line) => ({
      title: line.split("-")[0].trim(),
      description: line,
      link: line.match(/https?:\/\/[^\s)]+/g)?.[0] || "",
    })),

    certifications: extractSection(lines, ["certifications", "courses", "licenses"]).map((line) => ({
      name: line,
      issuer: "",
      date: chrono.parseDate(line)?.toISOString().split("T")[0] || "",
    })),

    languages: (() => {
      const line = extractSection(lines, ["languages", "spoken languages"])[0] || "";
      return line.split(/[,|•]+/).map(l => l.trim()).filter(Boolean);
    })(),

    hobbies: (() => {
      const line = extractSection(lines, ["hobbies", "interests"])[0] || "";
      return line.split(/[,|•]+/).map(h => h.trim()).filter(Boolean);
    })(),
  };

  return resume;
};

async function parseResumeFromPDF(filePath) {
  const buffer = fs.readFileSync(filePath);
  const pdfData = await pdf(buffer);
  const resume = parseResume(pdfData.text);
  return resume;
}

// Example usage
(async () => {
  const result = await parseResumeFromPDF("aryankarma_resume_ab.pdf");
  console.log(JSON.stringify(result, null, 2));
})();

