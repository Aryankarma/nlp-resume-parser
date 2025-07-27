const fs = require("fs");
const pdf = require("pdf-parse");
const nlp = require("compromise");
const chrono = require("chrono-node");
const fuzz = require("fuzzball");

// ==================== PRIMARY APPROACH: Enhanced Logic ====================

// Enhanced section keywords
const sectionKeywords = {
  summary: ['summary', 'profile', 'about', 'objective', 'career objective', 'job objective', 'profile summary', 'professional summary'],
  education: ['education', 'academic', 'qualification', 'educational background', 'academic background'],
  experience: ['experience', 'work experience', 'employment', 'professional experience', 'career history', 'work history'],
  articleship: ['articleship', 'article assistant', 'training', 'internship'],
  skills: ['skills', 'technical skills', 'core competencies', 'competencies', 'technologies', 'expertise'],
  projects: ['projects', 'key projects', 'notable projects', 'project experience'],
  certifications: ['certifications', 'certificates', 'awards', 'accolades', 'achievements', 'honors', 'achievement', 'position of responsibility', 'achievements & position of responsibilities'],
  languages: ['languages', 'language', 'spoken languages', 'language known'],
  hobbies: ['hobbies', 'interests', 'personal interests', 'activities']
};

// Robust section detection
const detectSections = (lines) => {
  const sections = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().toLowerCase();
    
    // Skip very short lines or lines that look like content
    if (line.length < 3 || line.startsWith('•') || line.match(/^\d/)) continue;
    
    for (const [sectionType, keywords] of Object.entries(sectionKeywords)) {
      for (const keyword of keywords) {
        // More strict matching for section headers
        const isExactMatch = line === keyword;
        const isCloseMatch = line.includes(keyword) && line.length <= keyword.length + 15;
        const isFuzzyMatch = fuzz.ratio(line, keyword) > 90;
        
        if (isExactMatch || isCloseMatch || isFuzzyMatch) {
          sections.push({
            type: sectionType,
            startIndex: i,
            header: lines[i].trim(),
            originalLine: line
          });
          break;
        }
      }
    }
  }
  
  // Sort by start index and add end indices
  sections.sort((a, b) => a.startIndex - b.startIndex);
  for (let i = 0; i < sections.length; i++) {
    sections[i].endIndex = i < sections.length - 1 ? sections[i + 1].startIndex : lines.length;
  }
  
  return sections;
};

// Enhanced contact extraction
const extractContactInfo = (text) => {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const phoneRegex = /\+91[-\s]?[6-9]\d{9}|\+\d{1,3}[-\s]?\d{8,15}/g;
  const linkedinRegex = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/[^\s|\]]+/gi;
  const githubRegex = /(?:https?:\/\/)?(?:www\.)?github\.com\/[^\s|\]]+/gi;
  
  return {
    email: text.match(emailRegex)?.[0] || "",
    phone: text.match(phoneRegex)?.[0] || "",
    linkedin: text.match(linkedinRegex)?.[0] || "",
    github: text.match(githubRegex)?.[0] || ""
  };
};

// Better date extraction
const extractDateRange = (text) => {
  // Enhanced patterns for various date formats
  const patterns = [
    // "Jan 2025 – Present"
    /([A-Za-z]{3,9}\s+\d{4})\s*[–\-—]\s*(Present|Current|Ongoing)/i,
    // "Jan 2025 – Dec 2025"
    /([A-Za-z]{3,9}\s+\d{4})\s*[–\-—]\s*([A-Za-z]{3,9}\s+\d{4})/i,
    // "2022 – 2026"
    /(\d{4})\s*[–\-—]\s*(\d{4})/,
    // "Aug 2024 – Dec 2024"
    /([A-Za-z]{3,9}\s+\d{4})\s*[–\-—]\s*([A-Za-z]{3,9}\s+\d{4})/i
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const startDate = chrono.parseDate(match[1]);
      let endDate;
      
      if (match[2] && (match[2].toLowerCase().includes('present') || 
                       match[2].toLowerCase().includes('current') || 
                       match[2].toLowerCase().includes('ongoing'))) {
        endDate = 'Present';
      } else {
        endDate = chrono.parseDate(match[2]);
      }
      
      return {
        startDate: startDate ? startDate.toISOString().split('T')[0] : "",
        endDate: endDate === 'Present' ? 'Present' : (endDate ? endDate.toISOString().split('T')[0] : "")
      };
    }
  }
  
  return { startDate: "", endDate: "" };
};

// ==================== SECONDARY APPROACH: Raw Data Extraction ====================

const extractRawSections = (text) => {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rawSections = {};
  
  // First, identify all section boundaries
  const sectionBoundaries = [];
  const commonSections = ['experience', 'education', 'skills', 'projects', 'achievements', 'certifications'];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    for (const section of commonSections) {
      if (line.includes(section) && line.length < section.length + 20) {
        sectionBoundaries.push({
          name: section,
          index: i,
          originalName: lines[i]
        });
        break;
      }
    }
  }
  
  // Extract raw content for each section
  sectionBoundaries.forEach((section, idx) => {
    const startIdx = section.index + 1;
    const endIdx = idx < sectionBoundaries.length - 1 ? sectionBoundaries[idx + 1].index : lines.length;
    
    rawSections[section.name] = {
      header: section.originalName,
      content: lines.slice(startIdx, endIdx),
      rawText: lines.slice(startIdx, endIdx).join('\n')
    };
  });
  
  return rawSections;
};

const parseRawExperience = (rawContent) => {
  const experiences = [];
  const lines = Array.isArray(rawContent) ? rawContent : rawContent.split('\n');
  
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    
    // Look for company names (usually standalone lines before dates)
    if (line && !line.startsWith('•') && !line.match(/\d{4}/) && line.length > 2) {
      let company = line;
      let dateRange = '';
      let position = '';
      let location = '';
      let bullets = [];
      
      // Look ahead for date range
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        const dateMatch = nextLine.match(/([A-Za-z]{3,9}\s+\d{4})\s*[–\-—]\s*([A-Za-z]{3,9}\s+\d{4}|Present|Current)/i);
        
        if (dateMatch) {
          dateRange = nextLine;
          i += 2; // Skip the date line
          
          // Look for position
          if (i < lines.length && !lines[i].startsWith('•')) {
            position = lines[i].trim();
            i++;
            
            // Look for location
            if (i < lines.length && !lines[i].startsWith('•') && lines[i].trim().length < 30) {
              location = lines[i].trim();
              i++;
            }
          }
          
          // Collect bullet points
          while (i < lines.length && lines[i].startsWith('•')) {
            bullets.push(lines[i].substring(1).trim());
            i++;
          }
          
          const dates = extractDateRange(dateRange);
          
          experiences.push({
            company: company,
            position: position,
            location: location,
            startDate: dates.startDate,
            endDate: dates.endDate,
            description: {
              overview: bullets
            }
          });
          
          continue;
        }
      }
    }
    i++;
  }
  
  return experiences;
};

const parseRawEducation = (rawContent) => {
  const education = [];
  const lines = Array.isArray(rawContent) ? rawContent : rawContent.split('\n');
  
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    
    // Look for university/institution names and degree patterns
    const degreePattern = /B\.?Tech|Bachelor|Master|M\.?Tech|B\.?Sc|M\.?Sc|B\.?A|M\.?A|BBA|MBA|ACA|University|College/i;
    const yearPattern = /(\d{4})\s*[–\-—]\s*(\d{4})/;
    
    if (degreePattern.test(line)) {
      const yearMatch = line.match(yearPattern);
      const degreeMatch = line.match(/(B\.?Tech|Bachelor|Master|M\.?Tech|B\.?Sc|M\.?Sc|B\.?A|M\.?A|BBA|MBA|ACA)/i);
      const fieldMatch = line.match(/(Computer Science|Engineering|Commerce|Arts|Science|Management|Accounting)/i);
      const cgpaMatch = line.match(/CGPA\s*:?\s*([\d.]+)/i);
      
      // Extract institution (usually at the beginning)
      let institution = line;
      if (degreeMatch) {
        institution = line.split(degreeMatch[0])[0].trim();
      }
      if (yearMatch) {
        institution = institution.replace(yearMatch[0], '').trim();
      }
      
      education.push({
        institution: institution || line.trim(),
        degree: degreeMatch ? degreeMatch[0].replace(/\./g, '') : "",
        fieldOfStudy: fieldMatch ? fieldMatch[0] : "",
        startDate: yearMatch ? `${yearMatch[1]}-01-01` : "",
        endDate: yearMatch ? `${yearMatch[2]}-12-31` : "",
        ...(cgpaMatch && { cgpa: cgpaMatch[1] })
      });
    }
  }
  
  return education;
};

const parseRawProjects = (rawContent) => {
  const projects = [];
  const lines = Array.isArray(rawContent) ? rawContent : rawContent.split('\n');
  
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    
    // Look for project titles (lines with | or technology stacks)
    if (line.includes('|') && !line.startsWith('•')) {
      const parts = line.split('|');
      const title = parts[0].trim();
      const technologies = parts[1] ? parts[1].trim() : "";
      
      // Extract GitHub/Live links
      const githubMatch = technologies.match(/GitHub[^\s]*/i);
      const liveMatch = technologies.match(/Live[^\s]*/i);
      
      const bullets = [];
      i++;
      
      // Collect associated bullet points
      while (i < lines.length && lines[i].startsWith('•')) {
        bullets.push(lines[i].substring(1).trim());
        i++;
      }
      
      projects.push({
        title: title,
        description: bullets,
        technologies: technologies.replace(/GitHub[^\s]*|Live[^\s]*/gi, '').trim(),
        link: githubMatch?.[0] || liveMatch?.[0] || ""
      });
      
      continue;
    }
    i++;
  }
  
  return projects;
};

// Main parsing function using secondary approach
const parseResumeSecondaryApproach = (text) => {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const contactInfo = extractContactInfo(text);
  const rawSections = extractRawSections(text);
  
  // Extract name from first few lines
  const name = lines.find(line => {
    const words = line.split(/\s+/);
    return words.length >= 2 && words.length <= 4 && 
           !line.match(/[@+\d]|resume|cv/i) &&
           words.every(w => w[0] === w[0].toUpperCase());
  }) || lines[0] || "";
  
  // Parse sections
  const workExperience = rawSections.experience ? parseRawExperience(rawSections.experience.content) : [];
  const education = rawSections.education ? parseRawEducation(rawSections.education.content) : [];
  const projects = rawSections.projects ? parseRawProjects(rawSections.projects.content) : [];
  
  // Extract skills
  const skills = [];
  if (rawSections.skills) {
    const skillsText = rawSections.skills.rawText;
    const skillLines = skillsText.split(/\n|:/);
    for (const line of skillLines) {
      if (line.trim()) {
        const skillList = line.split(/[,|•]+/).map(s => s.trim()).filter(s => s.length > 1 && s.length < 50);
        skills.push(...skillList);
      }
    }
  }
  
  // Extract certifications/achievements
  const certifications = [];
  if (rawSections.achievements || rawSections.certifications) {
    const achievementsText = (rawSections.achievements?.rawText || '') + (rawSections.certifications?.rawText || '');
    const achievementLines = achievementsText.split('\n').filter(line => line.trim());
    
    for (const line of achievementLines) {
      if (line.startsWith('•') || line.trim().length > 10) {
        certifications.push({
          name: line.replace(/^•\s*/, '').trim(),
          issuer: "",
          date: ""
        });
      }
    }
  }
  
  // Extract job roles
  const jobRoles = workExperience
    .map(exp => exp.position)
    .filter(pos => pos && pos.trim().length > 0);
  
  return {
    name: name,
    email: contactInfo.email,
    phone: contactInfo.phone,
    address: "",
    summary: "",
    linkedin: contactInfo.linkedin,
    jobRole: jobRoles,
    education: education,
    workExperience: workExperience,
    skills: [...new Set(skills)],
    projects: projects,
    certifications: certifications,
    languages: [],
    hobbies: []
  };
};

// Primary parsing function (enhanced version)
const parseResume = (text) => {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const sections = detectSections(lines);
  const contactInfo = extractContactInfo(text);
  
  // Extract name
  const name = lines.find(line => {
    const words = line.split(/\s+/);
    return words.length >= 2 && words.length <= 4 && 
           !line.match(/[@+\d]|resume|cv/i) &&
           words.every(w => w[0] === w[0].toUpperCase());
  }) || lines[0] || "";
  
  // Get section content
  const getSectionLines = (sectionType) => {
    const section = sections.find(s => s.type === sectionType);
    if (!section) return [];
    
    return lines.slice(section.startIndex + 1, section.endIndex).filter(line => line.trim());
  };
  
  const experienceLines = getSectionLines('experience');
  const educationLines = getSectionLines('education');
  const skillsLines = getSectionLines('skills');
  const projectsLines = getSectionLines('projects');
  const certificationsLines = getSectionLines('certifications');
  
  // Parse work experience with better logic
  const workExperience = parseRawExperience(experienceLines);
  const education = parseRawEducation(educationLines);
  const projects = parseRawProjects(projectsLines);
  
  // Parse skills
  const skills = [];
  for (const line of skillsLines) {
    const colonIndex = line.indexOf(':');
    const skillText = colonIndex > -1 ? line.substring(colonIndex + 1) : line;
    const skillList = skillText.split(/[,|•]+/).map(s => s.trim()).filter(s => s.length > 1 && s.length < 50);
    skills.push(...skillList);
  }
  
  // Parse certifications
  const certifications = [];
  for (const line of certificationsLines) {
    if (line.startsWith('•') || line.trim().length > 10) {
      certifications.push({
        name: line.replace(/^•\s*/, '').trim(),
        issuer: "",
        date: ""
      });
    }
  }
  
  const jobRoles = workExperience.map(exp => exp.position).filter(pos => pos && pos.trim().length > 0);
  
  return {
    name: name,
    email: contactInfo.email,
    phone: contactInfo.phone,
    address: "",
    summary: "",
    linkedin: contactInfo.linkedin,
    jobRole: jobRoles,
    education: education,
    workExperience: workExperience,
    skills: [...new Set(skills)],
    projects: projects,
    certifications: certifications,
    languages: [],
    hobbies: []
  };
};

// Main function
async function parseResumeFromPDF(filePath, useSecondaryApproach = false) {
  try {
    const buffer = fs.readFileSync(filePath);
    const pdfData = await pdf(buffer);
    
    if (useSecondaryApproach) {
      console.log("Using secondary approach (raw extraction)...");
      return parseResumeSecondaryApproach(pdfData.text);
    } else {
      console.log("Using primary approach (enhanced logic)...");
      return parseResume(pdfData.text);
    }
  } catch (error) {
    console.error('Error parsing PDF:', error);
    throw error;
  }
}

// Example usage
(async () => {
  try {
    console.log("=== PRIMARY APPROACH ===");
    const result1 = await parseResumeFromPDF("aryankarma_resume_ab.pdf", false);
    console.log(JSON.stringify(result1, null, 2));
    
    console.log("\n=== SECONDARY APPROACH ===");
    const result2 = await parseResumeFromPDF("aryankarma_resume_ab.pdf", true);
    console.log(JSON.stringify(result2, null, 2));
  } catch (error) {
    console.error('Failed to parse resume:', error);
  }
})();

module.exports = { parseResumeFromPDF, parseResume, parseResumeSecondaryApproach };