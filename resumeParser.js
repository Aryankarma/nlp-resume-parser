const fs = require("fs");
const pdf = require("pdf-parse");
const nlp = require("compromise");
const chrono = require("chrono-node");
const fuzz = require("fuzzball");

// Enhanced section keywords with more variations
const sectionKeywords = {
  summary: ['summary', 'profile', 'about', 'objective', 'career objective', 'job objective', 'profile summary', 'professional summary'],
  education: ['education', 'academic', 'qualification', 'educational background', 'academic background'],
  experience: ['experience', 'work experience', 'employment', 'professional experience', 'career history', 'work history'],
  articleship: ['articleship', 'article assistant', 'training', 'internship'],
  skills: ['skills', 'technical skills', 'core competencies', 'competencies', 'technologies', 'expertise'],
  projects: ['projects', 'key projects', 'notable projects', 'project experience'],
  certifications: ['certifications', 'certificates', 'awards', 'accolades', 'achievements', 'honors', 'achievement', 'position of responsibility'],
  languages: ['languages', 'language', 'spoken languages', 'language known'],
  hobbies: ['hobbies', 'interests', 'personal interests', 'activities']
};

// More precise section detection
const detectSectionBoundaries = (lines) => {
  const sections = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().toLowerCase();
    
    // Check for section headers (usually standalone lines or with specific patterns)
    for (const [sectionType, keywords] of Object.entries(sectionKeywords)) {
      for (const keyword of keywords) {
        // Match exact section headers or very close matches
        if (line === keyword || 
            (line.includes(keyword) && line.length <= keyword.length + 10) ||
            fuzz.ratio(line, keyword) > 85) {
          sections.push({
            type: sectionType,
            startIndex: i,
            header: lines[i].trim()
          });
          break;
        }
      }
    }
  }
  
  // Add end indices
  for (let i = 0; i < sections.length; i++) {
    const nextSection = sections[i + 1];
    sections[i].endIndex = nextSection ? nextSection.startIndex : lines.length;
  }
  
  return sections;
};

// Get section content by type
const getSectionContent = (sections, lines, sectionType) => {
  const section = sections.find(s => s.type === sectionType);
  if (!section) return [];
  
  const content = [];
  for (let i = section.startIndex + 1; i < section.endIndex; i++) {
    const line = lines[i].trim();
    if (line.length > 0) {
      content.push(line);
    }
  }
  
  return content;
};

// Extract contact information with better patterns
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

// Extract name from the first meaningful line
const extractName = (lines) => {
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const line = lines[i].trim();
    
    // Skip lines with contact info, common headers, or special characters
    if (line.match(/[@+\d]|resume|cv|curriculum/i) || line.length < 3 || line.length > 50) {
      continue;
    }
    
    // Check if it looks like a name (2-4 words, title case)
    const words = line.split(/\s+/);
    if (words.length >= 2 && words.length <= 4) {
      const hasProperCase = words.every(word => 
        word.length > 0 && 
        word[0] === word[0].toUpperCase() && 
        word.slice(1) === word.slice(1).toLowerCase()
      );
      
      if (hasProperCase) {
        return line;
      }
    }
  }
  
  return lines[0]?.trim() || "";
};

// Enhanced date extraction
const extractDatesFromText = (text) => {
  // Handle common formats like "Jan 2025 – Present", "Aug 2024 – Dec 2024"
  const dateRangePattern = /([A-Za-z]{3,9}\s+\d{4})\s*[–\-—]\s*([A-Za-z]{3,9}\s+\d{4}|Present|Current)/i;
  const singleDatePattern = /([A-Za-z]{3,9}\s+\d{4})/i;
  
  const rangeMatch = text.match(dateRangePattern);
  if (rangeMatch) {
    const startDate = chrono.parseDate(rangeMatch[1]);
    const endDate = rangeMatch[2].toLowerCase().includes('present') || rangeMatch[2].toLowerCase().includes('current') 
      ? 'Present' 
      : chrono.parseDate(rangeMatch[2]);
    
    return {
      startDate: startDate ? startDate.toISOString().split('T')[0] : "",
      endDate: endDate === 'Present' ? 'Present' : (endDate ? endDate.toISOString().split('T')[0] : "")
    };
  }
  
  const singleMatch = text.match(singleDatePattern);
  if (singleMatch) {
    const date = chrono.parseDate(singleMatch[1]);
    return {
      startDate: date ? date.toISOString().split('T')[0] : "",
      endDate: ""
    };
  }
  
  return { startDate: "", endDate: "" };
};

// Parse work experience with proper structure detection
const parseWorkExperience = (lines) => {
  const experiences = [];
  let currentExp = null;
  let collectingBullets = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Check if this line contains a date range (likely a job header)
    const dateMatch = line.match(/([A-Za-z]{3,9}\s+\d{4})\s*[–\-—]\s*([A-Za-z]{3,9}\s+\d{4}|Present|Current)/i);
    
    if (dateMatch) {
      // Save previous experience
      if (currentExp) {
        experiences.push(currentExp);
      }
      
      // Extract company name (usually the line before the date or at the start)
      let company = "";
      let position = "";
      let location = "";
      
      // Look for company name in previous lines or current line
      if (i > 0) {
        company = lines[i - 1].trim();
      }
      
      // Look for position and location in next lines
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        if (!nextLine.startsWith('•') && nextLine.length > 0) {
          position = nextLine;
        }
      }
      
      if (i + 2 < lines.length) {
        const locationLine = lines[i + 2].trim();
        if (!locationLine.startsWith('•') && locationLine.length < 20) {
          location = locationLine;
        }
      }
      
      const dates = extractDatesFromText(line);
      
      currentExp = {
        company: company,
        position: position,
        startDate: dates.startDate,
        endDate: dates.endDate,
        description: {
          overview: []
        }
      };
      
      collectingBullets = true;
      continue;
    }
    
    // Collect bullet points for current experience
    if (collectingBullets && currentExp) {
      if (line.startsWith('•')) {
        currentExp.description.overview.push(line.substring(1).trim());
      } else if (line.length > 0 && !line.match(/^[A-Z][a-z\s]+$/)) {
        // Add non-header lines to description
        if (currentExp.description.overview.length > 0) {
          currentExp.description.overview.push(line);
        }
      } else if (line.match(/^[A-Z][a-z\s]+$/) && line.length < 30) {
        // Potential new company name, stop collecting bullets
        collectingBullets = false;
      }
    }
  }
  
  // Add the last experience
  if (currentExp) {
    experiences.push(currentExp);
  }
  
  return experiences;
};

// Parse education section
const parseEducation = (lines) => {
  const educationEntries = [];
  
  for (const line of lines) {
    // Look for degree patterns
    const degreePattern = /B\.?Tech|Bachelor|Master|M\.?Tech|B\.?Sc|M\.?Sc|B\.?A|M\.?A|BBA|MBA|ACA/i;
    const yearPattern = /\d{4}/g;
    
    if (degreePattern.test(line)) {
      const years = line.match(yearPattern);
      const degreeMatch = line.match(degreePattern);
      
      // Extract field of study
      const fieldPattern = /(Computer Science|Engineering|Commerce|Arts|Science|Management|Accounting)/i;
      const fieldMatch = line.match(fieldPattern);
      
      // Extract institution (usually at the beginning)
      let institution = line.split(degreePattern)[0].trim();
      if (!institution) {
        institution = line.replace(degreePattern, '').replace(/\d{4}.*/, '').trim();
      }
      
      // Extract CGPA if present
      const cgpaMatch = line.match(/CGPA\s*:?\s*([\d.]+)/i);
      
      const entry = {
        institution: institution || line.trim(),
        degree: degreeMatch ? degreeMatch[0].replace(/\./g, '') : "",
        fieldOfStudy: fieldMatch ? fieldMatch[0] : "",
        startDate: years && years.length >= 2 ? `${years[0]}-01-01` : "",
        endDate: years && years.length >= 2 ? `${years[1]}-12-31` : ""
      };
      
      if (cgpaMatch) {
        entry.cgpa = cgpaMatch[1];
      }
      
      educationEntries.push(entry);
    }
  }
  
  return educationEntries;
};

// Parse skills section with better categorization
const parseSkills = (lines) => {
  const skills = [];
  
  for (const line of lines) {
    // Handle categorized skills (e.g., "Languages: C++, JavaScript")
    const categoryMatch = line.match(/^([^:]+):\s*(.+)$/);
    if (categoryMatch) {
      const skillsText = categoryMatch[2];
      const skillsList = skillsText.split(/[,|]+/).map(s => s.trim()).filter(s => s.length > 0);
      skills.push(...skillsList);
    } else {
      // Handle simple comma-separated skills
      const skillsList = line.split(/[,|•]+/).map(s => s.trim()).filter(s => s.length > 0 && s.length < 50);
      skills.push(...skillsList);
    }
  }
  
  return [...new Set(skills)]; // Remove duplicates
};

// Parse projects section
const parseProjects = (lines) => {
  const projects = [];
  let currentProject = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Check if line looks like a project title (contains | or has GitHub/Live links)
    if (line.includes('|') || line.includes('GitHub') || line.includes('Live') || 
        (line.match(/^[A-Z]/) && !line.startsWith('•'))) {
      
      if (currentProject) {
        projects.push(currentProject);
      }
      
      // Extract project title and technologies
      const parts = line.split('|');
      const title = parts[0].trim();
      const technologies = parts[1] ? parts[1].trim() : "";
      
      // Extract links
      const githubMatch = line.match(/GitHub[^\s]*/i);
      const liveMatch = line.match(/Live[^\s]*/i);
      
      currentProject = {
        title: title,
        description: [],
        technologies: technologies,
        link: githubMatch?.[0] || liveMatch?.[0] || ""
      };
    } else if (currentProject && line.startsWith('•')) {
      // Add bullet points to current project
      currentProject.description.push(line.substring(1).trim());
    }
  }
  
  if (currentProject) {
    projects.push(currentProject);
  }
  
  return projects;
};

// Parse certifications/achievements
const parseCertifications = (lines) => {
  const certifications = [];
  
  for (const line of lines) {
    if (line.startsWith('•') || line.trim().length > 10) {
      const cleanLine = line.replace(/^•\s*/, '').trim();
      if (cleanLine.length > 0) {
        certifications.push({
          name: cleanLine,
          issuer: "",
          date: ""
        });
      }
    }
  }
  
  return certifications;
};

// Extract job roles from work experience
const extractJobRoles = (workExperience) => {
  return workExperience
    .map(exp => exp.position)
    .filter(position => position && position.trim().length > 0)
    .map(position => position.trim());
};

// Main parsing function
const parseResume = (text) => {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const sections = detectSectionBoundaries(lines);
  const contactInfo = extractContactInfo(text);
  
  // Extract section contents
  const summaryContent = getSectionContent(sections, lines, 'summary');
  const educationContent = getSectionContent(sections, lines, 'education');
  const experienceContent = getSectionContent(sections, lines, 'experience');
  const skillsContent = getSectionContent(sections, lines, 'skills');
  const projectsContent = getSectionContent(sections, lines, 'projects');
  const certificationsContent = getSectionContent(sections, lines, 'certifications');
  const languagesContent = getSectionContent(sections, lines, 'languages');
  const hobbiesContent = getSectionContent(sections, lines, 'hobbies');
  
  // Parse sections
  const workExperience = parseWorkExperience(experienceContent);
  const education = parseEducation(educationContent);
  const skills = parseSkills(skillsContent);
  const projects = parseProjects(projectsContent);
  const certifications = parseCertifications(certificationsContent);
  
  // Build resume object
  const resume = {
    name: extractName(lines),
    email: contactInfo.email,
    phone: contactInfo.phone,
    address: "",
    summary: summaryContent.join(' '),
    linkedin: contactInfo.linkedin,
    jobRole: extractJobRoles(workExperience),
    education: education,
    workExperience: workExperience,
    skills: skills,
    projects: projects,
    certifications: certifications,
    languages: languagesContent.join(' ').split(/[,|]+/).map(l => l.trim()).filter(Boolean),
    hobbies: hobbiesContent.join(' ').split(/[,|]+/).map(h => h.trim()).filter(Boolean)
  };
  
  // Clean up empty fields
  Object.keys(resume).forEach(key => {
    if (Array.isArray(resume[key]) && resume[key].length === 0) {
      delete resume[key];
    } else if (typeof resume[key] === 'string' && resume[key].trim() === '') {
      delete resume[key];
    }
  });
  
  return resume;
};

// Main function to parse resume from PDF
async function parseResumeFromPDF(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const pdfData = await pdf(buffer);
    const resume = parseResume(pdfData.text);
    return resume;
  } catch (error) {
    console.error('Error parsing PDF:', error);
    throw error;
  }
}

// Example usage
(async () => {
  try {
    const result = await parseResumeFromPDF("aryankarma_resume_ab.pdf");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Failed to parse resume:', error);
  }
})();

module.exports = { parseResumeFromPDF, parseResume };